/** Helpers for the JSON Schemas in manifests (as produced by Zod's `toJSONSchema`). */
export type JsonSchema = Record<string, any>;

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array' | 'object' | 'any';

function members(schema: JsonSchema): JsonSchema[] {
  return (schema.anyOf ?? schema.oneOf ?? []) as JsonSchema[];
}

export function enumValues(schema: JsonSchema): unknown[] | null {
  if (Array.isArray(schema.enum)) return schema.enum;
  if ('const' in schema) return [schema.const];
  const m = members(schema);
  if (m.length && m.every((s) => Array.isArray(s.enum) || 'const' in s))
    return m.flatMap((s) => enumValues(s) ?? []);
  return null;
}

export function fieldKind(schema: JsonSchema | undefined): FieldKind {
  if (!schema) return 'any';
  if (enumValues(schema)) return 'enum';
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type;
  if (
    type === 'string' ||
    type === 'number' ||
    type === 'integer' ||
    type === 'boolean' ||
    type === 'array' ||
    type === 'object'
  )
    return type;
  const m = members(schema).filter((s) => s.type !== 'null');
  if (m.length === 1) return fieldKind(m[0]);
  if (m.some((s) => s.type === 'string')) return 'string';
  return 'any';
}

export function widget(schema: JsonSchema | undefined): string | undefined {
  if (!schema) return undefined;
  return (
    schema['x-zyrox']?.widget ??
    members(schema)
      .map((s) => s['x-zyrox']?.widget)
      .find(Boolean)
  );
}

export const isTemplate = (value: unknown): value is string =>
  typeof value === 'string' && value.includes('{{');

/** Properties of an object schema, in declaration order. */
export function properties(schema: JsonSchema | undefined): [string, JsonSchema][] {
  return Object.entries((schema?.properties ?? {}) as Record<string, JsonSchema>);
}

export function required(schema: JsonSchema | undefined): Set<string> {
  return new Set((schema?.required ?? []) as string[]);
}

/** Schemas for the arguments of built-in actions, so they share the props form. */
export const BUILTIN_ACTION_SCHEMAS: Record<string, JsonSchema> = {
  setState: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'State path, e.g. form.email' },
      value: { description: 'New value' },
    },
    required: ['path'],
  },
  navigate: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Screen key' },
      params: { type: 'object', description: 'Screen params' },
      presentation: { type: 'string', enum: ['push', 'replace', 'modal', 'sheet', 'reset'] },
      transition: { type: 'string' },
    },
    required: ['to'],
  },
  back: {
    type: 'object',
    properties: { result: { description: 'Optional result for the previous screen' } },
  },
  openUrl: {
    type: 'object',
    properties: { url: { type: 'string', 'x-zyrox': { widget: 'url' } } },
    required: ['url'],
  },
  request: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Relative to your API base URL' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      body: { description: 'Request body' },
      headers: { type: 'object' },
      into: { type: 'string', description: 'State path for the response' },
    },
    required: ['url'],
  },
  call: {
    type: 'object',
    properties: {
      fn: { type: 'string', description: 'Remote function name' },
      args: { type: 'object' },
      into: { type: 'string', description: 'State path for the result' },
    },
    required: ['fn'],
  },
  refresh: {
    type: 'object',
    properties: { data: { type: 'string', description: 'Data source key (empty: all)' } },
  },
  track: {
    type: 'object',
    properties: { event: { type: 'string' }, props: { type: 'object' } },
    required: ['event'],
  },
  setLocale: {
    type: 'object',
    properties: { locale: { type: 'string', description: 'e.g. fr' } },
    required: ['locale'],
  },
  if: {
    type: 'object',
    properties: { cond: { type: 'string', description: 'Expression, e.g. {{ state.ok }}' } },
    required: ['cond'],
  },
  validate: {
    type: 'object',
    properties: { form: { type: 'string', description: 'Form name; stops the list while invalid' } },
    required: ['form'],
  },
  resetForm: {
    type: 'object',
    properties: { form: { type: 'string' }, values: { description: 'Default: the initial state' } },
    required: ['form'],
  },
  setErrors: {
    type: 'object',
    properties: {
      form: { type: 'string' },
      errors: { description: 'e.g. {{ event.body.errors }}' },
    },
    required: ['form', 'errors'],
  },
  sheet: {
    type: 'object',
    properties: {
      screen: { type: 'string', description: 'Document key to show in the sheet' },
      params: { type: 'object' },
      title: { type: 'string' },
      size: { type: 'string', enum: ['auto', 'half', 'full'] },
      dismissible: { type: 'boolean', default: true },
      id: { type: 'string', description: 'Name it to close it with closeSheet' },
      content: {
        type: 'object',
        description: 'Instead of a screen: { title, message, image, buttons: [{ label, style, actions }] }',
      },
    },
  },
  closeSheet: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Empty: the top sheet' },
      result: { description: 'Handed to the sheet’s onClose as event' },
    },
  },
  alert: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      message: { type: 'string' },
      buttons: {
        type: 'array',
        description: '[{ label, style: default|primary|cancel|destructive, actions }]',
      },
    },
    required: ['title'],
  },
  toast: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      tone: { type: 'string', enum: ['info', 'success', 'warning', 'danger'] },
      duration: { type: 'number', description: 'Milliseconds (default 3000)' },
      action: { type: 'object', description: '{ label, actions } e.g. Undo' },
    },
    required: ['message'],
  },
};

export const ACTION_LISTS: Record<string, string[]> = {
  request: ['onSuccess', 'onError'],
  call: ['onSuccess', 'onError'],
  if: ['then', 'else'],
  sheet: ['onClose'],
};
