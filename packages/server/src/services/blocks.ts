import type { Problem } from '@zyrox/core/validate';
import type { Document, Node } from '@zyrox/protocol';

export const BLOCK_PREFIX = '@block/';
const MAX_DEPTH = 8;

function prefixIds(node: Node, prefix: string): Node {
  const rename = (n: Node): Node => ({
    ...n,
    id: `${prefix}/${n.id}`,
    ...(n.children ? { children: n.children.map(rename) } : {}),
    ...(n.slots
      ? { slots: Object.fromEntries(Object.entries(n.slots).map(([k, v]) => [k, v.map(rename)])) }
      : {}),
    ...(n.templates
      ? { templates: Object.fromEntries(Object.entries(n.templates).map(([k, v]) => [k, rename(v)])) }
      : {}),
    ...(n.fallback ? { fallback: rename(n.fallback) } : {}),
  });
  return rename(node);
}

/**
 * Replaces `{ "type": "@block/<key>", "props": {...} }` nodes with the block's published tree.
 * Inside a block, the instance props are available as `input`. Clients never see blocks.
 */
export function expandBlocks(
  doc: Document,
  getBlock: (key: string) => Document | undefined,
): { document: Document; used: string[]; problems: Problem[] } {
  const used = new Set<string>();
  const problems: Problem[] = [];

  const expand = (node: Node, stack: string[]): Node => {
    let current = node;
    if (node.type.startsWith(BLOCK_PREFIX)) {
      const key = node.type.slice(BLOCK_PREFIX.length);
      const block = getBlock(key);
      if (!block) {
        problems.push({
          level: 'error',
          code: 'unknown_component',
          message: `No published block "${key}"`,
          nodeId: node.id,
        });
        return { ...node, type: 'Block' };
      }
      if (stack.includes(key) || stack.length >= MAX_DEPTH) {
        problems.push({
          level: 'error',
          code: 'unknown_component',
          message: `Block "${key}" includes itself`,
          nodeId: node.id,
        });
        return { ...node, type: 'Block' };
      }
      used.add(key);
      const root = prefixIds(block.root, node.id);
      const {
        props,
        children: _children,
        slots: _slots,
        templates: _templates,
        type: _type,
        id: _id,
        ...instance
      } = node;
      current = {
        ...root,
        ...instance,
        id: node.id,
        with: { ...root.with, ...node.with, input: props ?? {} },
      };
      stack = [...stack, key];
    }
    return {
      ...current,
      ...(current.children ? { children: current.children.map((c) => expand(c, stack)) } : {}),
      ...(current.slots
        ? {
            slots: Object.fromEntries(
              Object.entries(current.slots).map(([k, v]) => [k, v.map((c) => expand(c, stack))]),
            ),
          }
        : {}),
      ...(current.templates
        ? {
            templates: Object.fromEntries(
              Object.entries(current.templates).map(([k, v]) => [k, expand(v, stack)]),
            ),
          }
        : {}),
      ...(current.fallback ? { fallback: expand(current.fallback, stack) } : {}),
    };
  };

  return { document: { ...doc, root: expand(doc.root, []) }, used: [...used], problems };
}

/** Block keys a document refers to. */
export function referencedBlocks(doc: Document): string[] {
  const keys = new Set<string>();
  const visit = (n: Node) => {
    if (n.type.startsWith(BLOCK_PREFIX)) keys.add(n.type.slice(BLOCK_PREFIX.length));
    n.children?.forEach(visit);
    for (const list of Object.values(n.slots ?? {})) list.forEach(visit);
    for (const t of Object.values(n.templates ?? {})) visit(t);
    if (n.fallback) visit(n.fallback);
  };
  visit(doc.root);
  return [...keys];
}
