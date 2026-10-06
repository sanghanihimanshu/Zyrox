import type { Document } from '@wishyor/zyrox-protocol';
import { PROTOCOL_VERSION } from '@wishyor/zyrox-protocol';
import { encodeHeader } from './client';

export interface FetchScreenOptions {
  endpoint: string;
  publicKey: string;
  /** Document key. */
  screen: string;
  /** The user's id, for rollouts and experiments (same as the app's `user`). */
  user?: string;
  attrs?: Record<string, string | number | boolean>;
  /** Preferred locales, e.g. from `Accept-Language`. */
  locale?: string | readonly string[];
  platform?: string;
  appVersion?: string;
  /** Your registry's `manifest.hash`, so release rules for app builds apply. */
  manifestHash?: string;
  /** Draft preview token: the draft instead of the release (Next.js draft mode…). */
  previewToken?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface FetchedScreen {
  key: string;
  /** Version ref: pass it to `<ZyroxScreen version>` so events carry it. */
  ref: string;
  document: Document;
  /** The experiment variant this user is in, to report exposure. */
  experiment?: { key: string; variant: string };
  preview?: boolean;
}

/**
 * Fetches one screen as this user would get it, in a single request: for server-side rendering
 * (Next.js server components, Remix loaders, Astro) or any headless use. Resolves `null` when the
 * screen isn't released. Render it with `<ZyroxScreen document={screen.document} version={screen.ref} />`.
 */
export async function fetchScreen(options: FetchScreenOptions): Promise<FetchedScreen | null> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.publicKey}`,
    'x-zyrox-client': encodeHeader({
      platform: options.platform ?? 'web',
      app: options.appVersion,
      manifest: options.manifestHash,
      protocol: PROTOCOL_VERSION,
    }),
  };
  if (options.user) headers['x-zyrox-user'] = options.user;
  if (options.attrs && Object.keys(options.attrs).length)
    headers['x-zyrox-attrs'] = encodeHeader(options.attrs);
  const locales = typeof options.locale === 'string' ? [options.locale] : (options.locale ?? []);
  if (locales.length) headers['accept-language'] = locales.join(', ');
  if (options.previewToken) headers['x-zyrox-preview'] = options.previewToken;
  const url = `${options.endpoint.replace(/\/+$/, '')}/v1/screens/${options.screen
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const res = await (options.fetch ?? fetch)(url, { headers, signal: options.signal });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Zyrox: HTTP ${res.status} for screen "${options.screen}"`);
  }
  return (await res.json()) as FetchedScreen;
}
