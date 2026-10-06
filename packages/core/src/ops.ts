import type { Document, Node, Op, SlotRef, Value } from '@wishyor/zyrox-protocol';
import { getIn, setIn, splitPath, unsetIn } from './path';

/**
 * Ops are the single way documents change: editor edits, undo/redo, live preview, AI and MCP
 * edits, and runtime streaming. `applyOp` returns a new document plus the ops that undo it.
 */

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

export interface Located {
  node: Node;
  parent: Node | null;
  slot: SlotRef;
  index: number;
}

type Container = { kind: 'list'; list: Node[] } | { kind: 'single'; node: Node | undefined };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function* walk(node: Node, parent: Node | null, slot: SlotRef, index: number): Generator<Located> {
  yield { node, parent, slot, index };
  for (const [i, child] of (node.children ?? []).entries()) yield* walk(child, node, 'children', i);
  for (const [name, list] of Object.entries(node.slots ?? {})) {
    for (const [i, child] of list.entries()) yield* walk(child, node, `slots.${name}`, i);
  }
  for (const [name, template] of Object.entries(node.templates ?? {}))
    yield* walk(template, node, `templates.${name}`, 0);
  if (node.fallback) yield* walk(node.fallback, node, 'fallback', 0);
}

/** Every node in the document, depth first, with its parent and position. */
export function listNodes(doc: Document): Located[] {
  return [...walk(doc.root, null, 'children', 0)];
}

export function findNode(doc: Document, id: string): Located | undefined {
  for (const located of walk(doc.root, null, 'children', 0)) if (located.node.id === id) return located;
  return undefined;
}

export function collectIds(node: Node, out = new Set<string>()): Set<string> {
  for (const { node: n } of walk(node, null, 'children', 0)) out.add(n.id);
  return out;
}

/** A readable id that is unique in the document, e.g. `button-3`. */
export function uniqueId(doc: Document, base: string): string {
  const ids = collectIds(doc.root);
  const stem =
    base
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'node';
  if (!ids.has(stem)) return stem;
  for (let i = 2; ; i++) if (!ids.has(`${stem}-${i}`)) return `${stem}-${i}`;
}

function container(parent: Node, slot: SlotRef, create: boolean): Container {
  if (slot === 'children') {
    if (!parent.children && create) parent.children = [];
    return { kind: 'list', list: parent.children ?? [] };
  }
  if (slot === 'fallback') return { kind: 'single', node: parent.fallback };
  const [kind, name] = slot.split('.') as [string, string | undefined];
  if (!name) throw new OpError(`Invalid slot "${slot}"`);
  if (kind === 'slots') {
    parent.slots ??= {};
    if (!parent.slots[name] && create) parent.slots[name] = [];
    return { kind: 'list', list: parent.slots[name] ?? [] };
  }
  if (kind === 'templates') return { kind: 'single', node: parent.templates?.[name] };
  throw new OpError(`Invalid slot "${slot}"`);
}

function setSingle(parent: Node, slot: SlotRef, node: Node | undefined): void {
  if (slot === 'fallback') {
    if (node) parent.fallback = node;
    else delete parent.fallback;
    return;
  }
  const name = slot.slice('templates.'.length);
  if (node) {
    parent.templates ??= {};
    parent.templates[name] = node;
  } else if (parent.templates) {
    delete parent.templates[name];
    if (Object.keys(parent.templates).length === 0) delete parent.templates;
  }
}

function cleanupEmpty(parent: Node, slot: SlotRef): void {
  if (slot === 'children' && parent.children?.length === 0) delete parent.children;
  if (slot.startsWith('slots.') && parent.slots) {
    const name = slot.slice('slots.'.length);
    if (parent.slots[name]?.length === 0) delete parent.slots[name];
    if (Object.keys(parent.slots).length === 0) delete parent.slots;
  }
}

const NODE_STRUCTURE = new Set(['id', 'children', 'slots', 'templates', 'fallback']);
const DOC_PROTECTED = new Set(['root', 'zyrox', 'kind']);

function checkPath(path: string, protectedKeys: Set<string>, what: string): string[] {
  const segments = splitPath(path);
  if (protectedKeys.has(segments[0]!))
    throw new OpError(`Cannot set "${path}" on a ${what}; use structural ops`);
  return segments;
}

export interface OpResult {
  doc: Document;
  /** Ops that undo this change, in the order they must be applied. */
  inverse: Op[];
}

/** Applies one op. Never mutates `doc`. Throws `OpError` when the op doesn't fit the document. */
export function applyOp(doc: Document, op: Op): OpResult {
  if (op.op === 'replace') return { doc: clone(op.document), inverse: [{ op: 'replace', document: doc }] };
  const next = clone(doc);
  switch (op.op) {
    case 'insert': {
      const parent = findNode(next, op.parent);
      if (!parent) throw new OpError(`No node "${op.parent}"`);
      const existing = collectIds(next.root);
      for (const id of collectIds(op.node))
        if (existing.has(id)) throw new OpError(`Node id "${id}" already exists`);
      const slot = op.slot ?? 'children';
      const target = container(parent.node, slot, true);
      if (target.kind === 'list') {
        const index = Math.min(op.index ?? target.list.length, target.list.length);
        target.list.splice(index, 0, clone(op.node));
        return { doc: next, inverse: [{ op: 'remove', id: op.node.id }] };
      }
      const replaced = target.node;
      setSingle(parent.node, slot, clone(op.node));
      const inverse: Op[] = [{ op: 'remove', id: op.node.id }];
      if (replaced) inverse.push({ op: 'insert', parent: op.parent, slot, node: replaced });
      return { doc: next, inverse };
    }
    case 'remove': {
      const located = findNode(next, op.id);
      if (!located) throw new OpError(`No node "${op.id}"`);
      if (!located.parent) throw new OpError('Cannot remove the root node');
      removeLocated(located);
      return {
        doc: next,
        inverse: [
          {
            op: 'insert',
            parent: located.parent.id,
            slot: located.slot,
            index: located.index,
            node: located.node,
          },
        ],
      };
    }
    case 'move': {
      const located = findNode(next, op.id);
      if (!located) throw new OpError(`No node "${op.id}"`);
      if (!located.parent) throw new OpError('Cannot move the root node');
      if (collectIds(located.node).has(op.parent)) throw new OpError('Cannot move a node into itself');
      const parent = findNode(next, op.parent);
      if (!parent) throw new OpError(`No node "${op.parent}"`);
      removeLocated(located);
      const slot = op.slot ?? 'children';
      const target = container(parent.node, slot, true);
      if (target.kind === 'list') {
        target.list.splice(Math.min(op.index ?? target.list.length, target.list.length), 0, located.node);
      } else {
        if (target.node) throw new OpError(`Slot "${slot}" of "${op.parent}" is occupied`);
        setSingle(parent.node, slot, located.node);
      }
      return {
        doc: next,
        inverse: [
          { op: 'move', id: op.id, parent: located.parent.id, slot: located.slot, index: located.index },
        ],
      };
    }
    case 'update': {
      const located = findNode(next, op.id);
      if (!located) throw new OpError(`No node "${op.id}"`);
      const node = located.node as unknown as Record<string, unknown>;
      const { result, inverse } = setAndUnset(node, op.set, op.unset, NODE_STRUCTURE, 'node');
      if (typeof result.type !== 'string' || !result.type) throw new OpError('A node needs a type');
      for (const k of Object.keys(node)) delete node[k];
      Object.assign(node, result);
      return { doc: next, inverse: [{ op: 'update', id: op.id, ...inverse }] };
    }
    case 'doc': {
      const { result, inverse } = setAndUnset(
        next as unknown as Record<string, unknown>,
        op.set,
        op.unset,
        DOC_PROTECTED,
        'document',
      );
      return { doc: result as unknown as Document, inverse: [{ op: 'doc', ...inverse }] };
    }
  }
}

function removeLocated(located: Located): void {
  const parent = located.parent!;
  const target = container(parent, located.slot, false);
  if (target.kind === 'list') {
    target.list.splice(located.index, 1);
    cleanupEmpty(parent, located.slot);
  } else {
    setSingle(parent, located.slot, undefined);
  }
}

function setAndUnset(
  target: Record<string, unknown>,
  set: Record<string, Value> | undefined,
  unset: string[] | undefined,
  protectedKeys: Set<string>,
  what: string,
): { result: Record<string, unknown>; inverse: { set?: Record<string, Value>; unset?: string[] } } {
  let result: unknown = target;
  const inverseSet: Record<string, Value> = {};
  const inverseUnset: string[] = [];
  const remember = (path: string, segments: string[]) => {
    if (path in inverseSet || inverseUnset.includes(path)) return;
    const previous = getIn(result, segments);
    if (previous === undefined) inverseUnset.push(path);
    else inverseSet[path] = clone(previous) as Value;
  };
  for (const [path, value] of Object.entries(set ?? {})) {
    const segments = checkPath(path, protectedKeys, what);
    remember(path, segments);
    result = setIn(result, segments, clone(value));
  }
  for (const path of unset ?? []) {
    const segments = checkPath(path, protectedKeys, what);
    remember(path, segments);
    result = unsetIn(result, segments);
  }
  return {
    result: result as Record<string, unknown>,
    inverse: {
      ...(Object.keys(inverseSet).length ? { set: inverseSet } : {}),
      ...(inverseUnset.length ? { unset: inverseUnset } : {}),
    },
  };
}

/** Applies ops in order. The returned inverse undoes all of them. */
export function applyOps(doc: Document, ops: readonly Op[]): OpResult {
  let current = doc;
  const inverses: Op[][] = [];
  for (const op of ops) {
    const result = applyOp(current, op);
    current = result.doc;
    inverses.push(result.inverse);
  }
  return { doc: current, inverse: inverses.reverse().flat() };
}
