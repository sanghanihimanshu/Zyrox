import type { Context } from 'hono';
import type { Db } from './db';
import type { environments, projects, Role, users } from './db/schema';
import type { AiClient, AiOptions } from './services/ai';
import type { Counters } from './services/counters';
import type { DeliveryCache } from './services/delivery-cache';
import type { CodeFunction } from './services/functions';
import type { PreviewHub } from './services/preview';
import type { PreviewTokens } from './services/preview-tokens';
import type { RuntimeTranslator } from './services/runtime-translate';
import type { SecretBox } from './services/secrets';
import type { TranslationProvider } from './services/translation';
import type { WebhookDispatcher } from './services/webhooks';

export interface ServerOptions {
  /** `postgres://…`, `memory://`, or a directory for embedded PGlite. Default `./.zyrox-data`. */
  database?: string;
  /** Functions that run inside the server, callable from documents with `{ "do": "call" }`. */
  functions?: Record<string, CodeFunction>;
  /** Let anyone sign up. By default only the first user can (and becomes the owner). */
  openSignup?: boolean;
  /** Mark cookies `Secure` (serve the dashboard over HTTPS). */
  secureCookies?: boolean;
  /** Built dashboard to serve at `/`. */
  dashboardDir?: string;
  /** How often buffered counters are written, in ms. `0` disables the timer (tests). */
  counterIntervalMs?: number;
  /** Public origin of this server (for preview links), e.g. `https://ui.example.com`. Default: the request origin. */
  publicUrl?: string;
  /** Encrypts stored webhook secrets (AES-256-GCM). Use a long random value and keep it safe. */
  secretKey?: string;
  /** Let webhooks call private / local network addresses and plain http (development only). */
  allowPrivateUrls?: boolean;
  /** Read the client IP from `X-Forwarded-For` (set when behind your own proxy or CDN). */
  trustProxy?: boolean;
  /** Requests per minute per client IP, or `false` to disable rate limiting. */
  rateLimits?: false | Partial<RateLimits>;
  /** Origins allowed to call the admin API from a browser with a token (custom admin UIs). */
  corsOrigins?: string[];
  /**
   * Translation model for the dashboard and runtime translation: Claude by default when AI is
   * configured, or `webhookTranslator`, `deeplTranslator`, `libreTranslator`, `textTranslator`
   * (any plain-text model) or your own `{ name, translate }`. `false` disables it.
   */
  translator?: TranslationProvider | false;
  /** Let apps machine-translate missing strings through `/v1/translate` (cached, rate limited). */
  runtimeTranslation?: boolean;
  /** Claude-powered assistant. Uses `ANTHROPIC_API_KEY` when `apiKey` is omitted. `false` disables it. */
  ai?: AiOptions | false;
  /** Delays before retrying a failed webhook delivery, in ms. Default 10 s, 1 min, 5 min. */
  webhookRetryDelays?: number[];
  /** Log internal warnings (webhook bookkeeping…). */
  debug?: boolean;
}

export type UserRow = typeof users.$inferSelect;

/** What a personal access token is limited to: one project and/or a maximum role. */
export interface TokenScope {
  projectId: string | null;
  role: Role | null;
}
export type ProjectRow = typeof projects.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;

export interface RateLimits {
  /** Sign-in and sign-up attempts. */
  auth: number;
  /** `/v1/bootstrap`, documents and strings. */
  delivery: number;
  /** Remote function calls. */
  functions: number;
  /** Telemetry and runtime translation. */
  telemetry: number;
  /** Admin API and MCP. */
  api: number;
}

export interface ServerContext {
  db: Db;
  options: ServerOptions;
  secrets: SecretBox;
  counters: Counters;
  preview: PreviewHub;
  delivery: DeliveryCache;
  webhooks: WebhookDispatcher;
  previewTokens: PreviewTokens;
  ai?: { client: AiClient; model: string; effort?: AiOptions['effort'] };
  /** Translation provider (dashboard "translate missing"), and the runtime endpoint when enabled. */
  translation?: { provider: TranslationProvider; runtime?: RuntimeTranslator };
}

export interface AppEnv {
  Variables: {
    user: UserRow;
    project: ProjectRow;
    role: Role;
    environment: EnvironmentRow;
    /** Restrictions of the personal access token used, if any. */
    scope: TokenScope | undefined;
  };
}

export type AppContext = Context<AppEnv>;
