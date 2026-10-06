import { findNode, uniqueId } from '@wishyor/zyrox-core';
import type { Document, Manifest, Node, Op, SlotRef, Value } from '@wishyor/zyrox-protocol';
import { enumValues, fieldKind, type JsonSchema, properties, required } from './schema';

function sample(name: string, schema: JsonSchema): Value {
  if (schema.default !== undefined) return schema.default as Value;
  switch (fieldKind(schema)) {
    case 'enum':
      return (enumValues(schema)?.[0] ?? '') as Value;
    case 'number':
    case 'integer':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return name === 'src' || name === 'image'
        ? 'https://picsum.photos/600/400'
        : name.charAt(0).toUpperCase() + name.slice(1);
  }
}

/** A new node with placeholder values for its required props. */
export function newNode(doc: Document, type: string, manifest?: Manifest): Node {
  const id = uniqueId(doc, type.replace(/^@block\//, ''));
  const component = manifest?.components[type];
  const props: Record<string, Value> = {};
  if (component) {
    const req = required(component.props);
    for (const [name, schema] of properties(component.props))
      if (req.has(name)) props[name] = sample(name, schema);
  }
  return Object.keys(props).length ? { id, type, props } : { id, type };
}

export function acceptsChildren(node: Node, manifest?: Manifest): boolean {
  if (node.type.startsWith('@block/')) return false;
  const c = manifest?.components[node.type];
  return c ? c.children : true;
}

/** Where a click in the palette inserts: into the selection if it takes children, else after it. */
export function insertionFor(
  doc: Document,
  selected: string | null,
  manifest?: Manifest,
): { parent: string; slot: SlotRef; index?: number } {
  const target = selected ? findNode(doc, selected) : undefined;
  if (!target) return { parent: doc.root.id, slot: 'children' };
  if (acceptsChildren(target.node, manifest)) return { parent: target.node.id, slot: 'children' };
  if (!target.parent || target.slot === 'fallback' || target.slot.startsWith('templates.'))
    return { parent: doc.root.id, slot: 'children' };
  return { parent: target.parent.id, slot: target.slot, index: target.index + 1 };
}

/** A copy of a node with fresh ids, inserted right after it. */
export function duplicateOps(doc: Document, id: string): { ops: Op[]; newId: string } | null {
  const located = findNode(doc, id);
  if (!located?.parent || located.slot === 'fallback' || located.slot.startsWith('templates.')) return null;
  let working = doc;
  const rename = (node: Node): Node => {
    const fresh = uniqueId(working, node.id.replace(/-\d+$/, ''));
    working = {
      ...working,
      root: { ...working.root, children: [...(working.root.children ?? []), { id: fresh, type: 'x' }] },
    };
    return {
      ...node,
      id: fresh,
      ...(node.children ? { children: node.children.map(rename) } : {}),
      ...(node.slots
        ? { slots: Object.fromEntries(Object.entries(node.slots).map(([k, v]) => [k, v.map(rename)])) }
        : {}),
      ...(node.templates
        ? { templates: Object.fromEntries(Object.entries(node.templates).map(([k, v]) => [k, rename(v)])) }
        : {}),
      ...(node.fallback ? { fallback: rename(node.fallback) } : {}),
    };
  };
  const copy = rename(located.node);
  return {
    ops: [
      { op: 'insert', parent: located.parent.id, slot: located.slot, index: located.index + 1, node: copy },
    ],
    newId: copy.id,
  };
}
