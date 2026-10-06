import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  canonicalJson,
  defineAction,
  defineComponent,
  documentJsonSchema,
  documentSchema,
  extendComponent,
  manifestSchema,
  opSchema,
  z,
  zx,
} from '../src';

const examples = import.meta.glob('../../../examples/components/documents/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

describe('documentSchema', () => {
  it('accepts every example document', () => {
    expect(Object.keys(examples).length).toBeGreaterThanOrEqual(4);
    for (const [file, doc] of Object.entries(examples)) {
      const result = documentSchema.safeParse(doc);
      expect(result.success, `${file}: ${result.error?.message}`).toBe(true);
    }
  });

  const base = { zyrox: 1, kind: 'screen', key: 'x', root: { id: 'r', type: 'Screen' } };

  it.each([
    ['wrong protocol', { ...base, zyrox: 2 }],
    ['node without id', { ...base, root: { type: 'Screen' } }],
    ['unknown node field', { ...base, root: { id: 'r', type: 'Screen', style: {} } }],
    ['bad bind path', { ...base, root: { id: 'r', type: 'Screen', bind: 'state..x' } }],
    ['setState without path', { ...base, root: { id: 'r', type: 'B', on: { press: [{ do: 'setState' }] } } }],
    [
      'nested bad action',
      {
        ...base,
        root: { id: 'r', type: 'B', on: { press: [{ do: 'if', cond: true, then: [{ do: 'navigate' }] }] } },
      },
    ],
    ['bad key', { ...base, key: ' spaces ' }],
    ['bad refresh', { ...base, data: { d: { url: '/x', refresh: ['sometimes'] } } }],
  ])('rejects %s', (_name, doc) => {
    expect(documentSchema.safeParse(doc).success).toBe(false);
  });

  it('allows custom actions with arbitrary args', () => {
    const doc = {
      ...base,
      root: { id: 'r', type: 'B', on: { press: [{ do: 'addToCart', productId: 'p1', qty: 2 }] } },
    };
    expect(documentSchema.safeParse(doc).success).toBe(true);
  });

  it('exports a JSON Schema for editors', () => {
    const schema = documentJsonSchema();
    expect(schema.type).toBe('object');
    expect(JSON.stringify(schema)).toContain('zyrox');
  });
});

describe('opSchema', () => {
  it('validates ops', () => {
    expect(opSchema.safeParse({ op: 'insert', parent: 'r', node: { id: 'a', type: 'Text' } }).success).toBe(
      true,
    );
    expect(
      opSchema.safeParse({
        op: 'insert',
        parent: 'r',
        slot: 'slots.footer',
        index: 0,
        node: { id: 'a', type: 'T' },
      }).success,
    ).toBe(true);
    expect(
      opSchema.safeParse({ op: 'update', id: 'a', set: { 'props.label': 'Hi' }, unset: ['if'] }).success,
    ).toBe(true);
    expect(opSchema.safeParse({ op: 'move', id: 'a', parent: 'b', slot: 'bogus' }).success).toBe(false);
    expect(opSchema.safeParse({ op: 'explode', id: 'a' }).success).toBe(false);
  });
});

describe('defineComponent + buildManifest', () => {
  const Card = defineComponent({
    name: 'Card',
    description: 'A card',
    props: z.object({
      title: z.string(),
      image: zx.image().optional(),
      tone: z.enum(['a', 'b']).default('a'),
    }),
    events: { press: z.object({ x: z.number() }) },
    children: true,
    slots: ['footer'],
  });
  const Field = defineComponent({
    name: 'Field',
    props: z.object({ value: z.string().default('') }),
    events: ['change'],
    bind: { prop: 'value', event: 'change' },
  });
  const Add = defineAction({ name: 'add', args: z.object({ id: z.string() }) });

  it('builds a manifest with JSON Schemas and editor hints', () => {
    const manifest = buildManifest({ components: [Card, Field], actions: [Add], helpers: ['t', 't'] });
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    const card = manifest.components.Card!;
    expect(card.description).toBe('A card');
    expect(card.children).toBe(true);
    expect(card.slots).toEqual(['footer']);
    expect(card.props.required).toEqual(['title']);
    expect(JSON.stringify(card.props)).toContain('"x-zyrox":{"widget":"image"}');
    expect(card.events.press).toMatchObject({ type: 'object' });
    expect(manifest.components.Field!.bind).toEqual({ prop: 'value', event: 'change' });
    expect(manifest.components.Field!.events).toEqual({ change: {} });
    expect(manifest.actions.add!.args.required).toEqual(['id']);
    expect(manifest.helpers).toEqual(['t']);
    expect(manifest.hash).toMatch(/^m_[0-9a-f]{28}$/);
  });

  it('hash is stable and order-independent, and changes with content', () => {
    const a = buildManifest({ components: [Card, Field], actions: [Add] });
    const b = buildManifest({ components: [Card, Field], actions: [Add] });
    expect(a.hash).toBe(b.hash);
    const c = buildManifest({ components: [Card], actions: [Add] });
    expect(c.hash).not.toBe(a.hash);
  });

  it('rejects duplicates and bad names', () => {
    expect(() => buildManifest({ components: [Card, Card] })).toThrow(/twice/);
    expect(() => defineComponent({ name: '1bad', props: z.object({}) })).toThrow(/Invalid/);
  });
});

describe('canonicalJson', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined }], c: null })).toBe(
      '{"a":[{"d":1}],"b":1,"c":null}',
    );
  });
});

describe('extendComponent', () => {
  const Card = defineComponent({
    name: 'Card',
    props: z.object({ title: z.string(), tone: z.enum(['a', 'b']).default('a') }),
    events: ['press'],
    children: true,
    slots: ['footer'],
  });

  it('adds props, events and slots without changing the base', () => {
    const Promo = extendComponent(Card, {
      name: 'PromoCard',
      props: { discount: z.number() },
      events: { dismiss: z.object({ reason: z.string() }) },
      slots: ['badge', 'footer'],
    });
    const m = buildManifest({ components: [Card, Promo] });
    expect(Object.keys(m.components.PromoCard!.props.properties as object)).toEqual([
      'title',
      'tone',
      'discount',
    ]);
    expect(Object.keys(m.components.PromoCard!.events)).toEqual(['press', 'dismiss']);
    expect(m.components.PromoCard!.slots).toEqual(['footer', 'badge']);
    expect(m.components.PromoCard!.children).toBe(true);
    expect(Object.keys(m.components.Card!.props.properties as object)).toEqual(['title', 'tone']);
    // Types flow through: discount is a number, tone is still the enum.
    const parsed = Promo.props.parse({ title: 'x', discount: 10 });
    expect(parsed.tone).toBe('a');
    expect(parsed.discount).toBe(10);
  });

  it('accepts a function to reshape props', () => {
    const Slim = extendComponent(Card, { name: 'SlimCard', props: (p) => p.omit({ tone: true }) });
    expect(Object.keys(Slim.props.shape)).toEqual(['title']);
  });
});
