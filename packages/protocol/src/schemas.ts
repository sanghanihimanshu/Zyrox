import { z } from 'zod';
import type { Action, Document, FormDef, Node, Op, Value } from './types';
import { PROTOCOL_VERSION } from './types';

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const statePath = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z0-9_$]+)*$/;

export const valueSchema: z.ZodType<Value> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(valueSchema),
    z.record(z.string(), valueSchema),
  ]),
);

const valueRecord = z.record(z.string(), valueSchema);

export const statePathSchema = z
  .string()
  .regex(statePath, 'Expected a dot path relative to state, e.g. "form.email"');

export const actionSchema: z.ZodType<Action> = z.lazy(() =>
  z
    .looseObject({
      do: z.string().min(1),
      onSuccess: z.array(actionSchema).optional(),
      onError: z.array(actionSchema).optional(),
      then: z.array(actionSchema).optional(),
      else: z.array(actionSchema).optional(),
      onClose: z.array(actionSchema).optional(),
    })
    .superRefine((action, ctx) => {
      const a = action as Record<string, unknown>;
      const need = (field: string) => {
        if (a[field] === undefined)
          ctx.addIssue({ code: 'custom', message: `"${a.do}" needs "${field}"`, path: [field] });
      };
      const check = (schema: z.ZodType, value: unknown, path: (string | number)[]) => {
        if (value === undefined) return;
        const result = schema.safeParse(value);
        if (!result.success)
          for (const issue of result.error.issues)
            ctx.addIssue({ code: 'custom', message: issue.message, path: [...path, ...issue.path] });
      };
      switch (a.do) {
        case 'setState':
          need('path');
          if (typeof a.path === 'string' && !statePath.test(a.path))
            ctx.addIssue({ code: 'custom', message: 'Invalid state path', path: ['path'] });
          break;
        case 'navigate':
          need('to');
          if (
            a.presentation !== undefined &&
            !['push', 'replace', 'modal', 'sheet', 'reset'].includes(a.presentation as string)
          )
            ctx.addIssue({
              code: 'custom',
              message: 'presentation must be push, replace, modal, sheet or reset',
              path: ['presentation'],
            });
          break;
        case 'openUrl':
          need('url');
          break;
        case 'request':
          need('url');
          if (typeof a.into === 'string' && !statePath.test(a.into))
            ctx.addIssue({ code: 'custom', message: 'Invalid state path', path: ['into'] });
          break;
        case 'call':
          need('fn');
          if (typeof a.into === 'string' && !statePath.test(a.into))
            ctx.addIssue({ code: 'custom', message: 'Invalid state path', path: ['into'] });
          break;
        case 'setLocale':
          need('locale');
          break;
        case 'track':
          need('event');
          break;
        case 'if':
          need('cond');
          break;
        case 'validate':
        case 'resetForm':
          need('form');
          break;
        case 'setErrors':
          need('form');
          need('errors');
          break;
        case 'sheet':
          if (a.screen === undefined && a.document === undefined && a.content === undefined)
            ctx.addIssue({ code: 'custom', message: '"sheet" needs "screen", "document" or "content"' });
          check(documentSchema, a.document, ['document']);
          check(z.looseObject({ buttons: z.array(overlayButtonSchema).optional() }), a.content, ['content']);
          check(z.enum(['auto', 'half', 'full']), a.size, ['size']);
          break;
        case 'alert':
          need('title');
          check(z.array(overlayButtonSchema), a.buttons, ['buttons']);
          break;
        case 'toast':
          need('message');
          check(z.enum(['info', 'success', 'warning', 'danger']), a.tone, ['tone']);
          check(z.looseObject({ label: valueSchema, actions: z.array(actionSchema).optional() }), a.action, [
            'action',
          ]);
          break;
      }
    }),
) as z.ZodType<Action>;

const overlayButtonSchema = z.looseObject({
  label: valueSchema,
  style: z.enum(['default', 'primary', 'cancel', 'destructive']).optional(),
  actions: z.array(z.lazy(() => actionSchema)).optional(),
});

export const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.strictObject({
    id: z.string().min(1),
    type: z.string().min(1),
    props: valueRecord.optional(),
    children: z.array(nodeSchema).optional(),
    slots: z.record(z.string(), z.array(nodeSchema)).optional(),
    templates: z.record(z.string(), nodeSchema).optional(),
    on: z.record(z.string(), z.array(actionSchema)).optional(),
    bind: statePathSchema.optional(),
    if: valueSchema.optional(),
    repeat: z
      .strictObject({
        each: valueSchema,
        as: z.string().regex(identifier).optional(),
        index: z.string().regex(identifier).optional(),
        key: valueSchema.optional(),
      })
      .optional(),
    with: z.record(z.string().regex(identifier), valueSchema).optional(),
    fallback: nodeSchema.optional(),
    a11y: z
      .strictObject({
        label: valueSchema.optional(),
        hint: valueSchema.optional(),
        role: z.string().optional(),
      })
      .optional(),
    motion: z
      .strictObject({
        enter: z.string().optional(),
        exit: z.string().optional(),
        layout: z.union([z.boolean(), z.string()]).optional(),
      })
      .optional(),
    meta: valueRecord.optional(),
  }),
);

const httpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const dataSourceSchema = z.strictObject({
  kind: z.string().optional(),
  if: valueSchema.optional(),
  url: valueSchema,
  method: httpMethod.optional(),
  headers: valueRecord.optional(),
  body: valueSchema.optional(),
  refresh: z.array(z.union([z.enum(['mount', 'foreground']), z.number().positive()])).optional(),
  debounce: z.number().int().min(0).max(10000).optional(),
  cache: z.number().min(0).max(86400).optional(),
  mock: valueSchema.optional(),
});

const ruleValue = (value: z.ZodType) =>
  z.union([value, z.strictObject({ value, message: valueSchema.optional() })]);
const flagRule = z.union([z.boolean(), valueSchema]);

export const fieldRulesSchema = z.strictObject({
  if: valueSchema.optional(),
  required: flagRule.optional(),
  minLength: ruleValue(valueSchema).optional(),
  maxLength: ruleValue(valueSchema).optional(),
  min: ruleValue(valueSchema).optional(),
  max: ruleValue(valueSchema).optional(),
  pattern: ruleValue(z.string().max(500)).optional(),
  email: flagRule.optional(),
  url: flagRule.optional(),
  oneOf: ruleValue(valueSchema).optional(),
  equals: ruleValue(valueSchema).optional(),
  rules: z
    .array(z.strictObject({ check: valueSchema, message: valueSchema }))
    .max(20)
    .optional(),
});

export const formSchema = z.strictObject({
  fields: z.record(
    z.string().regex(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/, 'Use a state path'),
    fieldRulesSchema,
  ),
  show: z.enum(['touched', 'submit']).optional(),
});

export const paramDefSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().optional(),
  default: valueSchema.optional(),
});

export const documentSchema: z.ZodType<Document> = z.strictObject({
  zyrox: z.literal(PROTOCOL_VERSION),
  kind: z.enum(['screen', 'block']),
  key: z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/i, 'Keys use letters, digits, ".", "_", "/" and "-"'),
  title: z.string().optional(),
  params: z.record(z.string().regex(identifier), paramDefSchema).optional(),
  state: valueRecord.optional(),
  data: z.record(z.string().regex(identifier), dataSourceSchema).optional(),
  forms: z.record(z.string().regex(identifier), formSchema as unknown as z.ZodType<FormDef>).optional(),
  root: nodeSchema,
  meta: valueRecord.optional(),
});

const slotRef = z.string().regex(/^(children|fallback|slots\.[A-Za-z0-9_$]+|templates\.[A-Za-z0-9_$]+)$/);

export const opSchema: z.ZodType<Op> = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('insert'),
    parent: z.string(),
    slot: slotRef.optional(),
    index: z.number().int().min(0).optional(),
    node: nodeSchema,
  }),
  z.strictObject({
    op: z.literal('update'),
    id: z.string(),
    set: valueRecord.optional(),
    unset: z.array(z.string()).optional(),
  }),
  z.strictObject({ op: z.literal('remove'), id: z.string() }),
  z.strictObject({
    op: z.literal('move'),
    id: z.string(),
    parent: z.string(),
    slot: slotRef.optional(),
    index: z.number().int().min(0).optional(),
  }),
  z.strictObject({
    op: z.literal('doc'),
    set: valueRecord.optional(),
    unset: z.array(z.string()).optional(),
  }),
  z.strictObject({ op: z.literal('replace'), document: documentSchema }),
]) as z.ZodType<Op>;

export const stringsBundleSchema = z.strictObject({
  zyrox: z.literal(PROTOCOL_VERSION),
  kind: z.literal('strings'),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a BCP 47 locale such as "en" or "fr-CA"'),
  messages: z.record(z.string(), z.string()),
});

const jsonSchemaObject = z.record(z.string(), z.unknown());

export const manifestSchema = z.strictObject({
  hash: z.string(),
  protocol: z.literal(PROTOCOL_VERSION),
  components: z.record(
    z.string(),
    z.strictObject({
      description: z.string().optional(),
      source: z.string().optional(),
      props: jsonSchemaObject,
      events: z.record(z.string(), jsonSchemaObject),
      children: z.boolean(),
      slots: z.array(z.string()),
      templates: z.array(z.string()),
      bind: z.strictObject({ prop: z.string(), event: z.string() }).optional(),
    }),
  ),
  actions: z.record(
    z.string(),
    z.strictObject({ description: z.string().optional(), args: jsonSchemaObject }),
  ),
  helpers: z.array(z.string()),
  motions: z.array(z.string()),
  transitions: z.array(z.string()),
  tokens: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number()]))),
});

/** JSON Schema of a Zyrox document, for editors such as Monaco. */
export function documentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(documentSchema, { unrepresentable: 'any' }) as Record<string, unknown>;
}
