import type { Document, Op } from '@zyrox/protocol';
import { describe, expect, it } from 'vitest';
import productJson from '../../../examples/components/documents/product.json';
import { applyOp, applyOps, findNode, listNodes, OpError, uniqueId } from '../src/ops';

const product = productJson as unknown as Document;

function roundTrip(doc: Document, ops: Op[]) {
  const { doc: next, inverse } = applyOps(doc, ops);
  const { doc: restored } = applyOps(next, inverse);
  expect(restored).toEqual(doc);
  return next;
}

describe('ops', () => {
  it('inserts into children, slots and templates', () => {
    const next = roundTrip(product, [
      {
        op: 'insert',
        parent: 'root',
        index: 1,
        node: { id: 'promo', type: 'Badge', props: { label: 'Sale' } },
      },
      { op: 'insert', parent: 'related', slot: 'slots.empty', node: { id: 'e2', type: 'Text' } },
      { op: 'insert', parent: 'header', slot: 'slots.trailing', node: { id: 'trail', type: 'Text' } },
    ]);
    expect(next.root.children![1]!.id).toBe('promo');
    expect(next.root.children!.find((n) => n.id === 'related')!.slots!.empty!.map((n) => n.id)).toEqual([
      'related-empty',
      'e2',
    ]);
    expect(findNode(next, 'trail')!.slot).toBe('slots.trailing');
  });

  it('replaces single slots and restores them on undo', () => {
    const next = roundTrip(product, [
      { op: 'insert', parent: 'related', slot: 'templates.item', node: { id: 'new-card', type: 'Card' } },
      { op: 'insert', parent: 'gallery', slot: 'fallback', node: { id: 'fb', type: 'Text' } },
    ]);
    expect(findNode(next, 'related-card')).toBeUndefined();
    expect(findNode(next, 'hero')).toBeUndefined();
    expect(findNode(next, 'fb')!.slot).toBe('fallback');
  });

  it('removes and moves', () => {
    const next = roundTrip(product, [
      { op: 'remove', id: 'loading' },
      { op: 'move', id: 'price', parent: 'header', index: 0 },
      { op: 'move', id: 'add', parent: 'root', index: 0 },
    ]);
    expect(next.root.children![0]!.id).toBe('add');
    expect(findNode(next, 'header')!.node.children!.map((n) => n.id)).toEqual(['price', 'name', 'new']);
  });

  it('updates node fields and document fields', () => {
    const next = roundTrip(product, [
      {
        op: 'update',
        id: 'add',
        set: { 'props.label': 'Buy now', 'props.variant': 'secondary', if: '{{ true }}' },
        unset: ['props.loading'],
      },
      { op: 'update', id: 'name', set: { type: 'Heading' } },
      {
        op: 'doc',
        set: { 'state.qty': 3, title: 'New title', 'data.reviews': { url: '/reviews' } },
        unset: ['state.gift'],
      },
    ]);
    const add = findNode(next, 'add')!.node;
    expect(add.props).toMatchObject({ label: 'Buy now', variant: 'secondary' });
    expect(add.props!.loading).toBeUndefined();
    expect(findNode(next, 'name')!.node.type).toBe('Heading');
    expect(next.state).toEqual({ qty: 3, adding: false });
    expect(next.data!.reviews).toEqual({ url: '/reviews' });
  });

  it('replaces the whole document', () => {
    const other: Document = { zyrox: 1, kind: 'screen', key: 'x', root: { id: 'r', type: 'Screen' } };
    roundTrip(product, [{ op: 'replace', document: other }]);
  });

  it('never mutates the input', () => {
    const before = JSON.stringify(product);
    applyOp(product, { op: 'remove', id: 'add' });
    applyOp(product, { op: 'update', id: 'add', set: { 'props.label': 'x' } });
    expect(JSON.stringify(product)).toBe(before);
  });

  it.each<[string, Op]>([
    ['missing parent', { op: 'insert', parent: 'nope', node: { id: 'a', type: 'T' } }],
    ['duplicate id', { op: 'insert', parent: 'root', node: { id: 'add', type: 'T' } }],
    [
      'duplicate nested id',
      { op: 'insert', parent: 'root', node: { id: 'ok', type: 'T', children: [{ id: 'price', type: 'T' }] } },
    ],
    ['remove root', { op: 'remove', id: 'root' }],
    ['move into itself', { op: 'move', id: 'header', parent: 'name' }],
    ['set structure', { op: 'update', id: 'add', set: { children: [] } }],
    ['set id', { op: 'update', id: 'add', set: { id: 'x' } }],
    ['clear type', { op: 'update', id: 'add', unset: ['type'] }],
    ['set root via doc', { op: 'doc', set: { root: { id: 'r', type: 'T' } } }],
    ['prototype path', { op: 'update', id: 'add', set: { '__proto__.x': 1 } }],
    ['occupied single slot', { op: 'move', id: 'price', parent: 'related', slot: 'templates.item' }],
  ])('rejects %s', (_name, op) => {
    expect(() => applyOp(product, op)).toThrow(/./);
  });

  it('lists nodes and generates unique ids', () => {
    const ids = listNodes(product).map((l) => l.node.id);
    expect(ids).toContain('related-card');
    expect(ids).toContain('hero');
    expect(uniqueId(product, 'Add')).toBe('add-2');
    expect(uniqueId(product, 'Fresh Node')).toBe('fresh-node');
    expect(OpError.name).toBe('OpError');
  });
});
