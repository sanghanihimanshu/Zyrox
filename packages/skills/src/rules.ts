import type { JsonSchema, Manifest, ManifestComponent } from '@wishyor/zyrox-protocol';

/** A short TypeScript-like rendering of a JSON schema, e.g. `"sm" | "md"` or `{ id: string }[]`. */
export function describeType(schema: JsonSchema | undefined, depth = 0): string {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if ('const' in schema) return JSON.stringify(schema.const);
  const union = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(union)) return union.map((s) => describeType(s, depth)).join(' | ');
  const widget = (schema['x-zyrox'] as { widget?: string } | undefined)?.widget;
  const type = schema.type;
  if (Array.isArray(type)) return type.map((t) => describeType({ ...schema, type: t }, depth)).join(' | ');
  switch (type) {
    case 'string':
      return widget ? `string (${widget})` : 'string';
    case 'number':
    case 'boolean':
    case 'null':
      return type;
    case 'integer':
      return 'integer';
    case 'array': {
      const item = describeType(schema.items as JsonSchema | undefined, depth + 1);
      return /[ |]/.test(item) && !item.startsWith('{') ? `(${item})[]` : `${item}[]`;
    }
    case 'object': {
      const properties = schema.properties as Record<string, JsonSchema> | undefined;
      if (!properties || !Object.keys(properties).length || depth > 1) return 'object';
      return `{ ${propertyList(schema, depth + 1).join(', ')} }`;
    }
    default:
      return 'any';
  }
}

function propertyList(schema: JsonSchema, depth: number): string[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties).map(([name, prop]) => {
    const fallback = 'default' in prop ? ` = ${JSON.stringify(prop.default)}` : '';
    return `${name}${required.has(name) ? '' : '?'}: ${describeType(prop, depth)}${fallback}`;
  });
}

export interface PropInfo {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
}

export function componentProps(component: ManifestComponent): PropInfo[] {
  const properties = (component.props.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((component.props.required ?? []) as string[]);
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: describeType(prop),
    required: required.has(name),
    ...('default' in prop ? { default: prop.default } : {}),
    ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
  }));
}

/** One-line signature: `ProductCard(title: string, tone?: "a" | "b" = "a") events: press slots: footer`. */
export function componentSignature(name: string, component: ManifestComponent): string {
  const parts = [`${name}(${propertyList(component.props, 1).join(', ')})`];
  const events = Object.entries(component.events).map(([event, payload]) =>
    Object.keys(payload).length ? `${event}: ${describeType(payload)}` : event,
  );
  if (events.length) parts.push(`events: ${events.join(', ')}`);
  if (component.children) parts.push('children');
  if (component.slots.length) parts.push(`slots: ${component.slots.join(', ')}`);
  if (component.templates.length) parts.push(`templates: ${component.templates.join(', ')}`);
  if (component.bind) parts.push(`bind: ${component.bind.prop} ⇄ ${component.bind.event}`);
  return parts.join(' ');
}

export interface DesignSystemRulesOptions {
  /** Project name for the title. */
  project?: string;
  /** App build label, e.g. `3.5.0`. */
  label?: string;
  /** How many screens use each component, to point agents at the common ones. */
  usage?: Record<string, number>;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Markdown rules for agents designing with this app's components (like Figma's
 * `create_design_system_rules`). Save it as `CLAUDE.md` / `AGENTS.md` or a rules file.
 */
export function designSystemRules(
  manifest: Manifest | undefined,
  options: DesignSystemRulesOptions = {},
): string {
  const title = `${options.project ? `${options.project} ` : ''}design system rules (Zyrox)`;
  if (!manifest) {
    return `# ${title}\n\nNo app manifest has been uploaded yet. Define components with \`defineComponent\`, register them, and run \`npx zyrox manifest push\` (see the zyrox-components skill).\n`;
  }
  const out: string[] = [`# ${title}`, ''];
  out.push(
    `Generated from app build manifest \`${manifest.hash}\`${options.label ? ` (${options.label})` : ''}. Regenerate after components change (MCP \`create_design_system_rules\` or \`npx zyrox skills rules\`).`,
    '',
    '## Rules',
    '',
    '- Screens are JSON documents rendered by this app’s own components. Use only the components, props, events, slots, templates and actions listed here; anything else fails validation.',
    '- Express visual choices through the enum props below (tone, variant, size, space…). Do not hard-code colors, sizes or fonts in documents.',
    '- Respect prop types and required props. Omit a prop (or pass `null`) to use its default.',
    '- Use templates for data lists, `if` for conditional UI, and give every data source realistic `mock` data so previews work.',
    '- Set `a11y.label` on icon-only buttons and meaningful images.',
    '- Give a `fallback` to nodes using components that were added recently, so older app builds still render.',
    '- Edit existing screens with small ops (MCP `apply_ops`); check problems with `validate_document`. Publishing is done by a person in the dashboard.',
    '- Need something the components can’t express? Add a component in code (MCP `scaffold_component`, zyrox-components skill) rather than nesting generic boxes.',
    '',
  );

  const names = Object.keys(manifest.components).sort((a, b) => {
    const byUse = (options.usage?.[b] ?? 0) - (options.usage?.[a] ?? 0);
    return byUse || a.localeCompare(b);
  });
  out.push(`## Components (${names.length})`, '');
  for (const name of names) {
    const c = manifest.components[name]!;
    out.push(`### ${name}`, '');
    if (c.description) out.push(c.description, '');
    const facts: string[] = [];
    if (c.source) facts.push(`Code: \`${c.source}\``);
    if (options.usage)
      facts.push(`Used in ${options.usage[name] ?? 0} screen${options.usage[name] === 1 ? '' : 's'}`);
    if (facts.length) out.push(facts.join(' · '), '');
    const props = componentProps(c);
    if (props.length) {
      out.push('| Prop | Type | Default | Notes |', '| --- | --- | --- | --- |');
      for (const p of props) {
        const fallback = 'default' in p ? `\`${JSON.stringify(p.default)}\`` : p.required ? 'required' : '';
        out.push(`| \`${p.name}\` | ${cell(p.type)} | ${cell(fallback)} | ${cell(p.description ?? '')} |`);
      }
      out.push('');
    }
    const extras: string[] = [];
    const events = Object.entries(c.events).map(([event, payload]) =>
      Object.keys(payload).length ? `\`${event}\` (event: ${describeType(payload)})` : `\`${event}\``,
    );
    if (events.length) extras.push(`Events: ${events.join(', ')}`);
    if (c.children) extras.push('Accepts children');
    if (c.slots.length) extras.push(`Slots: ${c.slots.map((s) => `\`${s}\``).join(', ')}`);
    if (c.templates.length)
      extras.push(`Templates: ${c.templates.map((t) => `\`${t}\``).join(', ')} (one node rendered per item)`);
    if (c.bind) extras.push(`Two-way binding: \`"bind": "<state path>"\` (${c.bind.prop} ⇄ ${c.bind.event})`);
    if (extras.length) out.push(...extras.map((e) => `- ${e}`), '');
  }

  const groups = Object.entries(manifest.tokens ?? {});
  if (groups.length) {
    out.push('## Design tokens', '', 'Reference only; documents select tokens through enum props.', '');
    for (const [group, tokens] of groups) {
      out.push(`### ${group}`, '', '| Token | Value |', '| --- | --- |');
      for (const [key, value] of Object.entries(tokens)) out.push(`| \`${key}\` | \`${value}\` |`);
      out.push('');
    }
  }

  const actions = Object.entries(manifest.actions);
  if (actions.length) {
    out.push('## App actions', '', 'Call as `{ "do": "<name>", ...args }` in `on` handlers.', '');
    for (const [name, action] of actions) {
      const args = propertyList(action.args, 1).join(', ');
      out.push(`- \`${name}\` { ${args} }${action.description ? ` — ${action.description}` : ''}`);
    }
    out.push('');
  }

  const misc: string[] = [];
  if (manifest.motions.length)
    misc.push(`Motion presets (\`motion.enter/exit\`): ${manifest.motions.join(', ')}`);
  if (manifest.transitions.length)
    misc.push(`Screen transitions (\`navigate.transition\`): ${manifest.transitions.join(', ')}`);
  if (manifest.helpers.length) misc.push(`App helpers for expressions: ${manifest.helpers.join(', ')}`);
  if (misc.length) out.push('## Motion, navigation and helpers', '', ...misc.map((m) => `- ${m}`), '');

  return `${out.join('\n').trimEnd()}\n`;
}
