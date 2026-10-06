// The server for browser tests: like `zyrox-server`, with a scripted assistant and translator
// instead of real models.
import { resolve } from 'node:path';
import { createZyroxServer } from '../../../packages/server/src/index';
import type { AiClient } from '../../../packages/server/src/services/ai';

type Params = { messages: { role: string; content: unknown }[] };
const reply = (content: unknown[], stop_reason: string) => ({
  id: 'msg_fake',
  type: 'message',
  role: 'assistant',
  model: 'fake-model',
  content,
  stop_reason,
  usage: {},
});

/** Inserts a badge, then answers once the tool result comes back. */
const assistant: AiClient = {
  beta: {
    messages: {
      stream(params) {
        const last = (params as unknown as Params).messages.at(-1)!;
        const answered =
          Array.isArray(last.content) && last.content.some((b: any) => b.type === 'tool_result');
        const message = answered
          ? reply([{ type: 'text', text: 'Added a sale badge.' }], 'end_turn')
          : reply(
              [
                { type: 'text', text: 'Adding a badge. ' },
                {
                  type: 'tool_use',
                  id: 'tu_1',
                  name: 'apply_ops',
                  input: {
                    summary: 'Add a sale badge',
                    ops_json: JSON.stringify([
                      {
                        op: 'insert',
                        parent: 'root',
                        index: 0,
                        node: {
                          id: 'sale-badge',
                          type: 'Badge',
                          props: { label: 'AI badge', tone: 'danger' },
                        },
                      },
                    ]),
                  },
                },
              ],
              'tool_use',
            );
        const listeners: ((text: string) => void)[] = [];
        return {
          on(_event: 'text', listener: (text: string) => void) {
            listeners.push(listener);
            return this;
          },
          async finalMessage() {
            for (const block of message.content as { type: string; text?: string }[])
              if (block.type === 'text') for (const l of listeners) l(block.text!);
            return message as any;
          },
        };
      },
      create: async () => {
        throw new Error('not used');
      },
    },
  },
};

const server = await createZyroxServer({
  database: 'memory://',
  dashboardDir: resolve(import.meta.dirname, '../dist'),
  ai: { client: assistant, model: 'fake-model' },
  translator: {
    name: 'fake-mt',
    translate: async ({ messages, locale }) =>
      Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, `[${locale}] ${v}`])),
  },
  runtimeTranslation: true,
});
await server.listen(Number(process.env.PORT ?? 4455));
console.log('e2e server ready');
