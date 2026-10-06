export type PropType =
  | 'string'
  | 'multiline'
  | 'image'
  | 'color'
  | 'url'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'string[]'
  | 'array'
  | 'object'
  | 'any';

export const PROP_TYPES: readonly PropType[] = [
  'string',
  'multiline',
  'image',
  'color',
  'url',
  'number',
  'integer',
  'boolean',
  'enum',
  'string[]',
  'array',
  'object',
  'any',
];

export interface PropSpec {
  type: PropType;
  /** Values of an `enum` prop (design tokens such as tone or size). */
  values?: string[];
  default?: string | number | boolean | unknown[];
  /** Without a default: may the document leave it out? (Default `true`; required props break old documents.) */
  optional?: boolean;
  description?: string;
}

export interface ComponentSpec {
  /** PascalCase name documents use as `type`. */
  name: string;
  description?: string;
  props?: Record<string, PropSpec>;
  events?: string[];
  children?: boolean;
  slots?: string[];
  templates?: string[];
  /** Two-way binding, e.g. `{ prop: 'value', event: 'change' }`. */
  bind?: { prop: string; event: string };
  /** Folder for components. Default `src/zyrox/components`. */
  dir?: string;
  /** Default `['web', 'native']`. */
  platforms?: ('web' | 'native')[];
  /** Package to import Zyrox from. Default `@zyrox/react`. */
  importFrom?: string;
}

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface ScaffoldResult {
  name: string;
  files: ScaffoldFile[];
  /** What to add to the registries and `zyrox.config.ts`. */
  registration: string;
  notes: string[];
}

const RESERVED = new Set(['children', 'slots', 'templates', 'a11y', 'nodeId', 'meta', 'key', 'ref', 'style']);
const identifier = /^[a-z][A-Za-z0-9]*$/;
const BINDABLE: PropType[] = ['string', 'multiline', 'url', 'color', 'number', 'integer', 'boolean', 'enum'];
const TEXT: PropType[] = ['string', 'multiline', 'number', 'integer'];

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
const literal = (v: unknown): string =>
  typeof v === 'string' ? q(v) : Array.isArray(v) ? `[${v.map(literal).join(', ')}]` : JSON.stringify(v);
const kebab = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function baseSchema(p: PropSpec): string {
  switch (p.type) {
    case 'string':
      return 'z.string()';
    case 'multiline':
    case 'image':
    case 'color':
    case 'url':
      return `zx.${p.type}()`;
    case 'number':
      return 'z.number()';
    case 'integer':
      return 'z.number().int()';
    case 'boolean':
      return 'z.boolean()';
    case 'enum':
      return `z.enum([${(p.values ?? []).map(q).join(', ')}])`;
    case 'string[]':
      return 'z.array(z.string())';
    case 'array':
      return 'z.array(z.unknown())';
    case 'object':
      return 'z.record(z.string(), z.unknown())';
    default:
      return 'z.unknown()';
  }
}

/** The `.optional()` / `.default()` rule: true when the implementation may receive `undefined`. */
const mayBeUndefined = (p: PropSpec) => p.default === undefined && p.optional !== false && p.type !== 'any';

function propSchema(p: PropSpec): string {
  let schema = baseSchema(p);
  if (p.description) schema += `.describe(${q(p.description)})`;
  if (p.default !== undefined) schema += `.default(${literal(p.default)})`;
  else if (mayBeUndefined(p)) schema += '.optional()';
  return schema;
}

/** Checks a spec; returns human-readable problems (empty when valid). */
export function checkComponentSpec(spec: ComponentSpec): string[] {
  const problems: string[] = [];
  if (!/^[A-Z][A-Za-z0-9]*$/.test(spec.name))
    problems.push(`Name "${spec.name}" must be PascalCase, e.g. "ProductCard"`);
  const props = spec.props ?? {};
  for (const [name, p] of Object.entries(props)) {
    if (!identifier.test(name)) problems.push(`Prop "${name}" must be camelCase`);
    if (RESERVED.has(name) || /^on[A-Z]/.test(name))
      problems.push(`Prop "${name}" is reserved (events become on<Event> handlers)`);
    if (!PROP_TYPES.includes(p.type)) problems.push(`Prop "${name}" has unknown type "${p.type}"`);
    if (p.type === 'enum' && !p.values?.length) problems.push(`Enum prop "${name}" needs "values"`);
    if (p.type === 'enum' && p.default !== undefined && !p.values?.includes(String(p.default)))
      problems.push(`Default of "${name}" must be one of its values`);
  }
  for (const [kind, names] of [
    ['Event', spec.events ?? []],
    ['Slot', spec.slots ?? []],
    ['Template', spec.templates ?? []],
  ] as const) {
    for (const n of names) if (!identifier.test(n)) problems.push(`${kind} "${n}" must be camelCase`);
    if (new Set(names).size !== names.length) problems.push(`${kind} names must be unique`);
  }
  if (spec.bind) {
    const prop = props[spec.bind.prop];
    if (!prop) problems.push(`bind.prop "${spec.bind.prop}" is not a prop`);
    else if (!BINDABLE.includes(prop.type))
      problems.push(`bind.prop "${spec.bind.prop}" must be a string, number, boolean or enum prop`);
    if (!identifier.test(spec.bind.event)) problems.push(`bind.event "${spec.bind.event}" must be camelCase`);
  }
  return problems;
}

/**
 * Generates a component definition plus starter web and React Native implementations
 * following Zyrox's conventions. The markup is a placeholder for your design system.
 */
export function scaffoldComponent(input: ComponentSpec): ScaffoldResult {
  const problems = checkComponentSpec(input);
  if (problems.length) throw new Error(problems.join('\n'));
  const spec: ComponentSpec = { ...input, props: { ...input.props }, events: [...(input.events ?? [])] };
  const props = spec.props!;
  const notes: string[] = [];
  const templates = spec.templates ?? [];
  let listProp = Object.keys(props).find((n) => ['array', 'string[]'].includes(props[n]!.type));
  if (templates.length && !listProp) {
    listProp = 'items';
    props.items = { type: 'array', default: [], description: 'Items rendered with the template' };
    notes.push('Added an "items" prop for the template to render.');
  }
  if (spec.bind && !spec.events!.includes(spec.bind.event)) spec.events!.push(spec.bind.event);

  const name = spec.name;
  const dir = `${(spec.dir ?? 'src/zyrox/components').replace(/\/+$/, '')}/${kebab(name)}`;
  const from = spec.importFrom ?? '@zyrox/react';
  const platforms = spec.platforms ?? ['web', 'native'];
  const def = `${name}Def`;

  // --- def.ts ---
  const usesZx = Object.values(props).some((p) => ['multiline', 'image', 'color', 'url'].includes(p.type));
  const propLines = Object.entries(props).map(([n, p]) => `    ${n}: ${propSchema(p)},`);
  const events = spec.events!;
  let eventsCode = '';
  if (spec.bind) {
    const bound = props[spec.bind.prop]!;
    const entries = events.map((e) => `${e}: ${e === spec.bind!.event ? baseSchema(bound) : 'z.unknown()'}`);
    eventsCode = `  events: { ${entries.join(', ')} },\n`;
  } else if (events.length) {
    eventsCode = `  events: [${events.map(q).join(', ')}],\n`;
  }
  const defCode = [
    `import { defineComponent, z${usesZx ? ', zx' : ''} } from ${q(from)};`,
    '',
    `export const ${def} = defineComponent({`,
    `  name: ${q(name)},`,
    ...(spec.description ? [`  description: ${q(spec.description)},`] : []),
    `  source: ${q(`${dir}/${name}.tsx`)},`,
    propLines.length ? `  props: z.object({\n${propLines.join('\n')}\n  }),` : '  props: z.object({}),',
    ...(eventsCode ? [eventsCode.trimEnd()] : []),
    ...(spec.children ? ['  children: true,'] : []),
    ...(spec.slots?.length ? [`  slots: [${spec.slots.map(q).join(', ')}],`] : []),
    ...(templates.length ? [`  templates: [${templates.map(q).join(', ')}],`] : []),
    ...(spec.bind ? [`  bind: { prop: ${q(spec.bind.prop)}, event: ${q(spec.bind.event)} },`] : []),
    '});',
    '',
  ].join('\n');

  const files: ScaffoldFile[] = [{ path: `${dir}/def.ts`, content: defCode }];
  const styleNotes = Object.entries(props)
    .filter(
      ([n, p]) => !TEXT.includes(p.type) && p.type !== 'image' && n !== spec.bind?.prop && n !== listProp,
    )
    .map(([n, p]) => `${n} (${p.type === 'enum' ? p.values!.join(' | ') : p.type})`);
  const pressEvent = events.find((e) => e === 'press');
  const otherEvents = events.filter((e) => e !== pressEvent && e !== spec.bind?.event);
  const header = [
    ...(styleNotes.length ? [`  // Also use: ${styleNotes.join(', ')}.`] : []),
    ...otherEvents.map((e) => `  // Call props.on${capitalize(e)}?.() when "${e}" happens.`),
  ];

  if (platforms.includes('web')) files.push({ path: `${dir}/${name}.tsx`, content: webCode() });
  if (platforms.includes('native')) files.push({ path: `${dir}/${name}.native.tsx`, content: nativeCode() });

  const registration = [
    '// Registries (web and native): add the implementation',
    `import { ${name} } from './${dir.replace(/^src\//, '')}/${name}';`,
    `createRegistry({ components: [/* … */, ${name}] });`,
    '',
    '// zyrox.config.ts: add the definition to the manifest, then run `npx zyrox manifest push`',
    `import { ${def} } from './${dir}/def';`,
    `manifest: { components: [/* … */, ${def}] }`,
  ].join('\n');
  return { name, files, registration, notes };

  function textNodes(tag: (value: string) => string): string[] {
    return Object.entries(props)
      .filter(([n, p]) => TEXT.includes(p.type) && n !== spec.bind?.prop)
      .map(([n, p]) =>
        mayBeUndefined(p) ? `{props.${n} !== undefined ? ${tag(`props.${n}`)} : null}` : tag(`props.${n}`),
      );
  }

  function webCode(): string {
    const body: string[] = [];
    for (const [n, p] of Object.entries(props)) {
      if (p.type === 'image')
        body.push(`{props.${n} ? <img src={props.${n}} alt={props.a11y?.label ?? ''} /> : null}`);
    }
    body.push(...textNodes((v) => `<span>{${v}}</span>`));
    if (spec.bind) body.push(webInput(spec.bind.prop, props[spec.bind.prop]!, spec.bind.event));
    if (listProp && templates.length)
      body.push(
        `<div>{Children.toArray(${listValue()}.map((item, index) => props.templates.${templates[0]}(item, index)))}</div>`,
      );
    if (spec.children) body.push('{props.children}');
    for (const slot of spec.slots ?? []) body.push(`{props.slots.${slot}}`);
    const attrs = [
      'data-zyrox-id={props.nodeId}',
      'aria-label={props.a11y?.label}',
      ...Object.entries(props)
        .filter(([n, p]) => (p.type === 'enum' || p.type === 'boolean') && n !== spec.bind?.prop)
        .map(([n, p]) => `data-${kebab(n)}={props.${n}${p.type === 'boolean' ? ' || undefined' : ''}}`),
      ...(pressEvent
        ? [
            "role={props.onPress ? 'button' : undefined}",
            'tabIndex={props.onPress ? 0 : undefined}',
            'onClick={() => props.onPress?.()}',
            "onKeyDown={(e) => e.key === 'Enter' && props.onPress?.()}",
          ]
        : []),
    ];
    return [
      ...(listProp && templates.length ? ["import { Children } from 'react';"] : []),
      `import { implement } from ${q(from)};`,
      `import { ${def} } from './def';`,
      '',
      `/** Web implementation of ${name}. Replace the markup with your design system. */`,
      `export const ${name} = implement(${def}, (props) => {`,
      ...header,
      '  return (',
      ...openTag('div', attrs),
      ...body.map((line) => `      ${line}`),
      '    </div>',
      '  );',
      '});',
      '',
    ].join('\n');
  }

  function nativeCode(): string {
    const rn = new Set<string>();
    const body: string[] = [];
    for (const [n, p] of Object.entries(props)) {
      if (p.type === 'image') {
        rn.add('Image');
        body.push(
          `{props.${n} ? <Image source={{ uri: props.${n} }} style={{ width: '100%', aspectRatio: 16 / 9 }} accessibilityLabel={props.a11y?.label} /> : null}`,
        );
      }
    }
    const texts = textNodes((v) => `<Text>{${v}}</Text>`);
    if (texts.length) rn.add('Text');
    body.push(...texts);
    if (spec.bind) body.push(nativeInput(spec.bind.prop, props[spec.bind.prop]!, spec.bind.event, rn));
    if (listProp && templates.length)
      body.push(
        `<View>{Children.toArray(${listValue()}.map((item, index) => props.templates.${templates[0]}(item, index)))}</View>`,
      );
    if (spec.children) body.push('{props.children}');
    for (const slot of spec.slots ?? []) body.push(`{props.slots.${slot}}`);
    const root = pressEvent ? 'Pressable' : 'View';
    rn.add(root);
    if (listProp && templates.length) rn.add('View');
    const attrs = [
      'testID={props.nodeId}',
      'accessibilityLabel={props.a11y?.label}',
      ...(pressEvent
        ? [
            "accessibilityRole={props.onPress ? 'button' : undefined}",
            'disabled={!props.onPress}',
            'onPress={() => props.onPress?.()}',
          ]
        : []),
    ];
    return [
      ...(listProp && templates.length ? ["import { Children } from 'react';"] : []),
      `import { ${[...rn].sort().join(', ')} } from 'react-native';`,
      `import { implement } from ${q(from)};`,
      `import { ${def} } from './def';`,
      '',
      `/** React Native implementation of ${name}. Replace the markup with your design system. */`,
      `export const ${name} = implement(${def}, (props) => {`,
      ...header,
      ...(listProp && templates.length
        ? ['  // Use FlatList or FlashList with renderItem for long lists.']
        : []),
      '  return (',
      ...openTag(root, attrs),
      ...body.map((line) => `      ${line}`),
      `    </${root}>`,
      '  );',
      '});',
      '',
    ].join('\n');
  }

  function openTag(tag: string, attrs: string[]): string[] {
    return attrs.length > 2
      ? [`    <${tag}`, ...attrs.map((a) => `      ${a}`), '    >']
      : [`    <${tag} ${attrs.join(' ')}>`];
  }

  function listValue(): string {
    return mayBeUndefined(props[listProp!]!) ? `(props.${listProp} ?? [])` : `props.${listProp}`;
  }

  function webInput(prop: string, p: PropSpec, event: string): string {
    const handler = `props.on${capitalize(event)}`;
    const value = `props.${prop}`;
    const optional = mayBeUndefined(p);
    switch (p.type) {
      case 'boolean':
        return `<input type="checkbox" checked={${value}${optional ? ' ?? false' : ''}} onChange={(e) => ${handler}?.(e.target.checked)} />`;
      case 'number':
      case 'integer':
        return `<input type="number" value={${value}${optional ? " ?? ''" : ''}} onChange={(e) => ${handler}?.(Number(e.target.value))} />`;
      case 'enum':
        return `<select value={${value}${optional ? " ?? ''" : ''}} onChange={(e) => ${handler}?.(e.target.value as NonNullable<typeof ${value}>)}>{[${p.values!.map(q).join(', ')}].map((option) => <option key={option} value={option}>{option}</option>)}</select>`;
      case 'multiline':
        return `<textarea value={${value}${optional ? " ?? ''" : ''}} onChange={(e) => ${handler}?.(e.target.value)} />`;
      default:
        return `<input value={${value}${optional ? " ?? ''" : ''}} onChange={(e) => ${handler}?.(e.target.value)} />`;
    }
  }

  function nativeInput(prop: string, p: PropSpec, event: string, rn: Set<string>): string {
    const handler = `props.on${capitalize(event)}`;
    const value = `props.${prop}`;
    const optional = mayBeUndefined(p);
    switch (p.type) {
      case 'boolean':
        rn.add('Switch');
        return `<Switch value={${value}${optional ? ' ?? false' : ''}} onValueChange={(next) => ${handler}?.(next)} />`;
      case 'number':
      case 'integer':
        rn.add('TextInput');
        return `<TextInput keyboardType="numeric" value={String(${value} ?? '')} onChangeText={(text) => ${handler}?.(Number(text))} />`;
      case 'enum':
        rn.add('Pressable');
        rn.add('Text');
        return `{([${p.values!.map(q).join(', ')}] as const).map((option) => <Pressable key={option} accessibilityState={{ selected: ${value} === option }} onPress={() => ${handler}?.(option)}><Text>{option}</Text></Pressable>)}`;
      default:
        rn.add('TextInput');
        return `<TextInput${p.type === 'multiline' ? ' multiline' : ''} value={${value}${optional ? " ?? ''" : ''}} onChangeText={(text) => ${handler}?.(text)} />`;
    }
  }
}
