/**
 * JSON Schema (2020-12) of UI actions, messages and trigger rules, for backends in any language.
 * Also published as `@zyrox/actions/schema.json` (`ui-actions.schema.json` in the package).
 */
const json = { description: 'Any JSON value' };
const list = (ref: string) => ({ type: 'array', items: { $ref: ref } });
const action = (name: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: { do: { const: name }, ...properties },
  required: ['do', ...required],
});

export const uiJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:zyrox:ui-actions:1',
  title: 'Zyrox UI actions',
  description:
    'Actions a backend sends to a Zyrox app: in API responses as `$actions`, or as messages over SSE, WebSocket, push or polling.',
  oneOf: [{ $ref: '#/$defs/message' }, { $ref: '#/$defs/actions' }],
  $defs: {
    actions: list('#/$defs/action'),
    button: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        style: { enum: ['default', 'primary', 'cancel', 'destructive'] },
        actions: { $ref: '#/$defs/actions' },
      },
      required: ['label'],
    },
    action: {
      type: 'object',
      required: ['do'],
      properties: { do: { type: 'string', minLength: 1 } },
      anyOf: [
        action(
          'navigate',
          {
            to: { type: 'string' },
            params: { type: 'object' },
            presentation: { enum: ['push', 'replace', 'modal', 'sheet', 'reset'] },
            transition: { type: 'string' },
          },
          ['to'],
        ),
        action('back', { result: json }),
        action('openUrl', { url: { type: 'string' } }, ['url']),
        {
          ...action('sheet', {
            id: { type: 'string' },
            screen: { type: 'string' },
            document: { type: 'object', required: ['zyrox', 'kind', 'key', 'root'] },
            params: { type: 'object' },
            content: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                message: { type: 'string' },
                image: { type: 'string' },
                buttons: list('#/$defs/button'),
              },
            },
            title: { type: 'string' },
            size: { enum: ['auto', 'half', 'full'] },
            dismissible: { type: 'boolean' },
            onClose: { $ref: '#/$defs/actions' },
          }),
          anyOf: [{ required: ['screen'] }, { required: ['document'] }, { required: ['content'] }],
        },
        action('closeSheet', { id: { type: 'string' }, result: json }),
        action(
          'alert',
          { title: { type: 'string' }, message: { type: 'string' }, buttons: list('#/$defs/button') },
          ['title'],
        ),
        action(
          'toast',
          {
            message: { type: 'string' },
            tone: { enum: ['info', 'success', 'warning', 'danger'] },
            duration: { type: 'number', minimum: 0 },
            action: {
              type: 'object',
              properties: { label: { type: 'string' }, actions: { $ref: '#/$defs/actions' } },
              required: ['label'],
            },
          },
          ['message'],
        ),
        action('refresh', { data: { type: 'string' } }),
        action('track', { event: { type: 'string' }, props: { type: 'object' } }, ['event']),
        action('setState', { path: { type: 'string' }, value: json }, ['path']),
        action('setLocale', { locale: { type: 'string' } }, ['locale']),
        action('setErrors', { form: { type: 'string' }, errors: { type: ['object', 'array'] } }, [
          'form',
          'errors',
        ]),
        action('resetForm', { form: { type: 'string' }, values: json }, ['form']),
        action('if', { cond: json, then: { $ref: '#/$defs/actions' }, else: { $ref: '#/$defs/actions' } }, [
          'cond',
        ]),
        {
          description: "An action the app registered (allowed only when listed in the app's remoteActions)",
          type: 'object',
          properties: {
            do: {
              type: 'string',
              not: {
                enum: [
                  'navigate',
                  'back',
                  'openUrl',
                  'sheet',
                  'closeSheet',
                  'alert',
                  'toast',
                  'refresh',
                  'track',
                  'setState',
                  'setLocale',
                  'setErrors',
                  'resetForm',
                  'if',
                ],
              },
            },
          },
        },
      ],
    },
    trigger: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        on: { enum: ['screen_view', 'track', 'app_open', 'foreground'] },
        name: { type: 'string' },
        screen: { type: 'string' },
        if: { type: 'string', description: 'Expression, e.g. "{{ event.props.total >= 499 }}"' },
        once: { type: 'boolean' },
        cooldown: { type: 'number', minimum: 0, description: 'Seconds' },
        maxPerSession: { type: 'integer', minimum: 0 },
        delay: { type: 'number', minimum: 0, description: 'Milliseconds' },
        startsAt: { type: ['string', 'number'] },
        endsAt: { type: ['string', 'number'] },
        actions: { $ref: '#/$defs/actions' },
      },
      required: ['id', 'on', 'actions'],
    },
    message: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        actions: { $ref: '#/$defs/actions' },
        triggers: list('#/$defs/trigger'),
        expiresAt: { type: ['string', 'number'] },
      },
      anyOf: [{ required: ['actions'] }, { required: ['triggers'] }],
    },
  },
} as const;
