#!/usr/bin/env -S npx tsx
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZyroxServer } from './server';
import {
  deeplTranslator,
  libreTranslator,
  type TranslationProvider,
  webhookTranslator,
} from './services/translation';

const env = process.env;
const bundledDashboard = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/dashboard/dist');

/** ZYROX_TRANSLATOR = claude (default with ANTHROPIC_API_KEY) | webhook | deepl | libretranslate | off */
function translatorFromEnv(): TranslationProvider | false | undefined {
  const kind = env.ZYROX_TRANSLATOR;
  const url = env.ZYROX_TRANSLATOR_URL ?? '';
  const key = env.ZYROX_TRANSLATOR_KEY;
  if (!kind || kind === 'claude') return undefined;
  if (kind === 'off') return false;
  if (kind === 'webhook') return webhookTranslator({ url, token: key });
  if (kind === 'deepl') return deeplTranslator({ apiKey: key ?? '', url: url || undefined });
  if (kind === 'libretranslate') return libreTranslator({ url, apiKey: key });
  throw new Error(`Unknown ZYROX_TRANSLATOR "${kind}"`);
}

const server = await createZyroxServer({
  database: env.DATABASE_URL ?? './.zyrox-data',
  openSignup: env.ZYROX_OPEN_SIGNUP === 'true',
  secureCookies: env.ZYROX_SECURE_COOKIES === 'true',
  publicUrl: env.ZYROX_PUBLIC_URL,
  secretKey: env.ZYROX_SECRET_KEY,
  trustProxy: env.ZYROX_TRUST_PROXY === 'true',
  allowPrivateUrls: env.ZYROX_ALLOW_PRIVATE_URLS === 'true',
  rateLimits: env.ZYROX_RATE_LIMITS === 'off' ? false : undefined,
  corsOrigins: env.ZYROX_CORS_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  dashboardDir: env.ZYROX_DASHBOARD_DIR ?? (existsSync(bundledDashboard) ? bundledDashboard : undefined),
  ai:
    env.ZYROX_AI === 'false'
      ? false
      : {
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.ZYROX_AI_MODEL,
          effort: env.ZYROX_AI_EFFORT as 'low' | 'medium' | 'high' | undefined,
        },
  translator: translatorFromEnv(),
  runtimeTranslation: env.ZYROX_RUNTIME_TRANSLATION === 'true',
});

if (!env.ZYROX_SECRET_KEY)
  console.warn('[zyrox] ZYROX_SECRET_KEY is not set: webhook secrets are stored unencrypted.');

const { port } = await server.listen(Number(env.PORT ?? 4400), env.HOST ?? '0.0.0.0');
console.log(`Zyrox server listening on http://localhost:${port} (${server.database.kind})`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
