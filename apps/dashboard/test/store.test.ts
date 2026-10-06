import type { Document } from '@zyrox/protocol';
import { buildManifest } from '@zyrox/protocol';
import { describe, expect, it, vi } from 'vitest';
import { exampleManifestInput } from '../../../examples/components/src/manifest';
import { duplicateOps, insertionFor, newNode } from '../src/editor/create';
import { EditorStore } from '../src/editor/store';
import { ApiError } from '../src/lib/api';

const manifest = buildManifest(exampleManifestInput);
const doc: Document = {
  zyrox: 1,
  kind: 'screen',
  key: 'home',
  root: { id: 'root', type: 'Screen', children: [{ id: 'title', type: 'Text', props: { text: 'Hi' } }] },
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('EditorStore', () => {
  it('applies ops, batches saves while a request is in flight, and tracks revisions', async () => {
    const calls: { ops: unknown[]; revision: number }[] = [];
    const pending: ReturnType<typeof deferred<{ draft: { revision: number } }>>[] = [];
    const send = vi.fn((_path: string, body: unknown) => {
      calls.push(body as { ops: unknown[]; revision: number });
      const d = deferred<{ draft: { revision: number } }>();
      pending.push(d);
      return d.promise;
    });
    const store = new EditorStore('/p/x/documents/home', doc, 1, send);
    store.apply([{ op: 'update', id: 'title', set: { 'props.text': 'A' } }]);
    store.apply([{ op: 'update', id: 'title', set: { 'props.text': 'AB' } }]);
    store.apply([{ op: 'update', id: 'title', set: { 'props.text': 'ABC' } }]);
    expect(store.getSnapshot().save).toBe('saving');
    expect(calls).toHaveLength(1);
    pending[0]!.resolve({ draft: { revision: 2 } });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({
      revision: 2,
      ops: [
        { op: 'update', id: 'title', set: { 'props.text': 'AB' } },
        { op: 'update', id: 'title', set: { 'props.text': 'ABC' } },
      ],
    });
    pending[1]!.resolve({ draft: { revision: 3 } });
    await vi.waitFor(() => expect(store.getSnapshot().save).toBe('saved'));
    expect(store.getSnapshot().revision).toBe(3);
    expect((store.doc.root.children![0]!.props as { text: string }).text).toBe('ABC');
  });

  it('undoes and redoes, and saves those too', async () => {
    const send = vi.fn(async (_path: string, _body: unknown) => ({ draft: { revision: 5 } }));
    const store = new EditorStore('/x', doc, 1, send);
    store.apply(
      [{ op: 'insert', parent: 'root', node: { id: 'b', type: 'Button', props: { label: 'Go' } } }],
      { select: 'b' },
    );
    expect(store.getSnapshot().selected).toBe('b');
    store.undo();
    expect(store.doc.root.children).toHaveLength(1);
    expect(store.getSnapshot().selected).toBe('root');
    expect(store.getSnapshot().canRedo).toBe(true);
    store.redo();
    expect(store.doc.root.children).toHaveLength(2);
    await store.settled();
    expect(send.mock.calls.flatMap((c) => (c[1] as { ops: { op: string }[] }).ops.map((o) => o.op))).toEqual([
      'insert',
      'remove',
      'insert',
    ]);
  });

  it('stops on conflicts and retries other failures', async () => {
    const store = new EditorStore('/x', doc, 1, async () => {
      throw new ApiError('Someone else changed this document', 409);
    });
    store.apply([{ op: 'update', id: 'title', set: { 'props.text': 'X' } }]);
    await vi.waitFor(() => expect(store.getSnapshot().save).toBe('conflict'));

    let fail = true;
    const flaky = new EditorStore('/x', doc, 1, async () => {
      if (fail) throw new Error('offline');
      return { draft: { revision: 2 } };
    });
    flaky.apply([{ op: 'update', id: 'title', set: { 'props.text': 'Y' } }]);
    await vi.waitFor(() => expect(flaky.getSnapshot().save).toBe('error'));
    fail = false;
    await flaky.flush();
    expect(flaky.getSnapshot().save).toBe('saved');
  });

  it('reports invalid ops without changing anything', () => {
    const store = new EditorStore('/x', doc, 1, async () => ({ draft: { revision: 2 } }));
    expect(store.tryApply([{ op: 'remove', id: 'root' }])).toMatch(/root/);
    expect(store.getSnapshot().canUndo).toBe(false);
  });
});

describe('node helpers', () => {
  it('creates nodes with placeholder required props and finds where to insert', () => {
    expect(newNode(doc, 'Button', manifest)).toEqual({
      id: 'button',
      type: 'Button',
      props: { label: 'Label' },
    });
    expect(newNode(doc, 'Image', manifest)).toMatchObject({
      props: { src: 'https://picsum.photos/600/400' },
    });
    expect(insertionFor(doc, 'root', manifest)).toEqual({ parent: 'root', slot: 'children' });
    expect(insertionFor(doc, 'title', manifest)).toEqual({ parent: 'root', slot: 'children', index: 1 });
  });

  it('duplicates a subtree with fresh ids', () => {
    const dup = duplicateOps(doc, 'title')!;
    expect(dup.newId).toBe('title-2');
    expect(duplicateOps(doc, 'root')).toBeNull();
  });
});
