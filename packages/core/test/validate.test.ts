import { buildManifest, type Document } from '@zyrox/protocol';
import { describe, expect, it } from 'vitest';
import { exampleManifestInput } from '../../../examples/components/src/manifest';
import { hasErrors, validateDocument } from '../src/validate';

const docs = import.meta.glob(
  ['../../../examples/components/documents/*.json', '../../../examples/components/documents/sections/*.json'],
  { eager: true, import: 'default' },
) as Record<string, Document>;
const manifest = buildManifest(exampleManifestInput);

function doc(root: Document['root'], extra: Partial<Document> = {}): Document {
  return { zyrox: 1, kind: 'screen', key: 't', ...extra, root };
}

describe('validateDocument', () => {
  it('passes every example document (fallbacks are warnings)', () => {
    for (const [file, d] of Object.entries(docs)) {
      const problems = validateDocument(d, { manifest });
      expect(
        problems.filter((p) => p.level === 'error'),
        file,
      ).toEqual([]);
      for (const p of problems) expect(p.code, `${file}: ${p.message}`).toBe('unknown_component');
    }
  });

  it('reports structure errors with paths', () => {
    const problems = validateDocument({ zyrox: 1, kind: 'screen', key: 't', root: { type: 'Screen' } });
    expect(problems[0]).toMatchObject({ level: 'error', code: 'schema', path: 'root.id' });
  });

  it('finds expression, helper and reference problems', () => {
    const problems = validateDocument(
      doc(
        {
          id: 'r',
          type: 'Screen',
          children: [
            { id: 'a', type: 'Text', props: { text: '{{ state.x + }}' } },
            { id: 'b', type: 'Text', props: { text: '{{ shout(state.x) }}' } },
            {
              id: 'c',
              type: 'Text',
              props: { text: '{{ item.name }} {{ data.nope }} {{ params.missing }}' },
            },
            {
              id: 'd',
              type: 'Text',
              repeat: { each: '{{ data.list }}', as: 'row' },
              props: { text: '{{ row.name }} {{ index }}' },
            },
            {
              id: 'e',
              type: 'Button',
              props: { label: 'x' },
              on: { press: [{ do: 'setState', path: 'v', value: '{{ event }}' }] },
            },
          ],
        },
        { data: { list: { url: '/l' } }, params: { id: { type: 'string' } } },
      ),
      { manifest },
    );
    const summary = problems.map((p) => [p.nodeId, p.code, p.level]);
    expect(summary).toEqual([
      ['a', 'expression', 'error'],
      ['b', 'unknown_helper', 'error'],
      ['c', 'unknown_identifier', 'warning'],
      ['c', 'unknown_reference', 'warning'],
      ['c', 'unknown_reference', 'warning'],
    ]);
  });

  it('checks components, props, events, slots, bindings, actions and motion', () => {
    const problems = validateDocument(
      doc({
        id: 'r',
        type: 'Screen',
        children: [
          { id: 'u', type: 'Mystery' },
          { id: 'p', type: 'Button', props: { variant: 'huge', extra: 1 } },
          {
            id: 'e',
            type: 'Text',
            props: { text: 'x' },
            on: { press: [], appear: [] },
            children: [{ id: 'k', type: 'Text', props: { text: 'y' } }],
          },
          {
            id: 's',
            type: 'Card',
            slots: { header: [] },
            templates: { row: { id: 'row', type: 'Text', props: { text: '{{ item }}' } } },
          },
          { id: 'bd', type: 'Text', props: { text: 'x' }, bind: 'x' },
          { id: 'tf', type: 'TextField', bind: 'email' },
          {
            id: 'ac',
            type: 'Button',
            props: { label: 'x' },
            on: {
              press: [
                { do: 'launch' },
                { do: 'addToCart', qty: 0 },
                { do: 'navigate', to: 'x', transition: 'warp' },
              ],
            },
          },
          { id: 'mo', type: 'Text', props: { text: 'x' }, motion: { enter: 'fade', exit: 'spin' } },
        ],
      }),
      { manifest },
    );
    const codes = problems.map((p) => `${p.nodeId}:${p.code}`);
    expect(codes).toEqual([
      'u:unknown_component',
      'p:missing_prop',
      'p:invalid_prop',
      'p:unknown_prop',
      'e:unknown_event',
      'e:children_not_allowed',
      's:unknown_slot',
      's:unknown_template',
      'bd:not_bindable',
      'ac:unknown_action',
      'ac:invalid_action_args',
      'ac:invalid_action_args',
      'ac:unknown_transition',
      'mo:unknown_motion',
    ]);
    expect(hasErrors(problems)).toBe(true);
  });

  it('flags duplicate ids', () => {
    const problems = validateDocument(
      doc({ id: 'r', type: 'Screen', children: [{ id: 'r', type: 'Text', props: { text: 'x' } }] }),
      { manifest },
    );
    expect(problems.map((p) => p.code)).toEqual(['duplicate_id']);
  });

  it('works without a manifest', () => {
    expect(
      validateDocument(doc({ id: 'r', type: 'Anything', props: { a: '{{ t("x") }} {{ shout("x") }}' } })),
    ).toEqual([expect.objectContaining({ code: 'unknown_helper', level: 'warning' })]);
  });
});
