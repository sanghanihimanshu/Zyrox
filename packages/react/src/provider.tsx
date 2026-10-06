import {
  type BundleLoader,
  DataCache,
  type Fetcher,
  type FunctionCaller,
  I18n,
  type Messages,
  type MissingTranslator,
  type NavigateOptions,
  type Observer,
  OverlayController,
  type RuntimeHost,
  ScreenRuntime,
  type Snapshot,
  ZyroxClient,
} from '@wishyor/zyrox-core';
import type { Document } from '@wishyor/zyrox-protocol';
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DynamicContext, StableContext, useZyrox, type ZyroxDynamic, type ZyroxStable } from './context';
import { type OverlayComponents, OverlayHost } from './overlay-host';
import { getPlatform, type ZyroxStorage } from './platform-api';
import type { Registry } from './registry';

export interface ZyroxProviderProps {
  registry: Registry;
  children?: ReactNode;

  // Delivery from a Zyrox server --------------------------------------------------------------
  /** Zyrox server URL. Without it, render inline documents with `<ZyroxScreen document={…} />`. */
  endpoint?: string;
  /** Public (read-only) key of the environment. */
  publicKey?: string;
  appVersion?: string;
  /** Stable user/install id for rollouts and experiments. Generated and stored when omitted. */
  user?: string;
  /** Targeting attributes (country, plan…). */
  attrs?: Record<string, string | number | boolean>;
  /** Your signed-in user's token, forwarded to remote functions so they can authenticate the caller. */
  userToken?: () => string | null | undefined | Promise<string | null | undefined>;
  storage?: ZyroxStorage;
  /** Bundled bootstrap + documents for the first launch with no network (`zyrox snapshot`). */
  snapshot?: Snapshot;
  /**
   * Documents shipped with the app, by key. `<ZyroxScreen screen="…">` renders one when there is
   * no server, or the server has no released version (yet). Handy for local development, tests,
   * default screens, and sections the server may override.
   */
  documents?: Record<string, Document>;
  /** Bring your own client (tests, sharing between providers). */
  client?: ZyroxClient;
  /**
   * Show drafts instead of releases (QA builds, stakeholder reviews): a token from the dashboard
   * or `zyrox preview-token`. Read once, when the provider mounts.
   */
  previewToken?: string;

  // Your app ------------------------------------------------------------------------------------
  fetcher?: Fetcher;
  apiBaseUrl?: string;
  allowedOrigins?: string[];
  urlSchemes?: string[];
  navigate?(to: string, params: Record<string, unknown>, options: NavigateOptions): void;
  back?(result?: unknown): void;
  openUrl?(url: string): unknown;
  /** Route `call` actions yourself (Firebase, Lambda…). Defaults to the Zyrox server. */
  callFunction?: FunctionCaller;
  /** Analytics, logging, error tracking, tracing: each observer receives every event. */
  observers?: Observer[];
  /** Exposed to documents as `app` (user, feature flags…). */
  app?: Record<string, unknown>;

  // Languages -------------------------------------------------------------------------------------
  /** Active language. Change it to switch at runtime. Default: best match of the device locales. */
  locale?: string;
  defaultLocale?: string;
  /** Translations shipped with the app, by locale. */
  strings?: Record<string, Messages>;
  /** Fetch translations from your own source instead of (or without) the Zyrox server. */
  loadStrings?: BundleLoader;
  /**
   * Translate missing keys at runtime with any model: on-device (ML Kit, Apple Translation),
   * your cloud, a function… Defaults to the Zyrox server's translation provider when it has
   * runtime translation on. For plain-text models, `splitMessage` from `@wishyor/zyrox-core` protects
   * placeholders and plurals.
   */
  translateMissing?: MissingTranslator;
  /** Shared cache for data sources with `cache`. Pass your own to clear it on sign-out. */
  dataCache?: DataCache;
  /** Bring your own i18n instance (to share it with non-Zyrox UI). */
  i18n?: I18n;

  // Overlays and backend-triggered UI -------------------------------------------------------------
  /**
   * Components for the `sheet`, `alert` and `toast` actions: `defaultOverlays` from
   * `@wishyor/zyrox-react/overlays`, or your design system's.
   */
  overlays?: OverlayComponents;
  /**
   * Actions your backend may trigger (`$actions` in responses, streams, push, trigger rules).
   * Default: UI and navigation built-ins (`DEFAULT_REMOTE_ACTIONS`). List app actions to allow them.
   */
  remoteActions?: readonly string[];

  /** Use data source mocks instead of fetching. */
  mock?: boolean;
  /** Log events to the console and check props against schemas. */
  debug?: boolean;
}

/** Provides the registry, your app's callbacks, languages and (optionally) server delivery. */
export function ZyroxProvider(props: ZyroxProviderProps): ReactNode {
  const platform = getPlatform();
  const latest = useRef(props);
  latest.current = props;

  const [client] = useState<ZyroxClient | undefined>(() => {
    if (props.client) return props.client;
    if (!props.endpoint) return undefined;
    if (!props.publicKey) throw new Error('<ZyroxProvider endpoint> needs a publicKey');
    return new ZyroxClient({
      endpoint: props.endpoint,
      publicKey: props.publicKey,
      manifestHash: props.registry.manifest.hash,
      platform: platform.name,
      appVersion: props.appVersion,
      user: props.user,
      attrs: props.attrs,
      userToken: () => latest.current.userToken?.(),
      locales: () => [latest.current.locale ?? '', ...platform.preferredLocales()].filter(Boolean),
      storage: props.storage ?? platform.defaultStorage(),
      snapshot: props.snapshot,
      previewToken: props.previewToken,
    });
  });

  const [i18n] = useState<I18n>(
    () =>
      props.i18n ??
      new I18n({
        locale: props.locale,
        defaultLocale: props.defaultLocale,
        preferred: platform.preferredLocales(),
        local: props.strings,
        loader: (locale) =>
          (latest.current.loadStrings ?? client?.loadStrings)?.(locale) ?? Promise.resolve(null),
        // Your translator (e.g. an on-device model), else the server's provider when it offers one.
        translateMissing: (req) =>
          (latest.current.translateMissing ?? client?.translateMissing)?.(req) ?? Promise.resolve(null),
        onMissing: (key, locale) => {
          if (latest.current.debug) console.debug(`[zyrox] missing translation "${key}" (${locale})`);
        },
      }),
  );

  // A host object that never changes identity but always calls the latest props.
  const [dataCache] = useState(() => props.dataCache ?? new DataCache());
  const [overlays] = useState(() => new OverlayController());
  const [extraObservers] = useState(() => new Set<Observer>());
  const [receiver] = useState<ZyroxStable['receiver']>(() => ({}));
  const host = useMemo<RuntimeHost>(
    () => ({
      dataCache,
      get fetcher() {
        return latest.current.fetcher;
      },
      get apiBaseUrl() {
        return latest.current.apiBaseUrl;
      },
      get allowedOrigins() {
        return latest.current.allowedOrigins;
      },
      get urlSchemes() {
        return latest.current.urlSchemes;
      },
      get mock() {
        return latest.current.mock;
      },
      get debug() {
        return latest.current.debug;
      },
      get actions() {
        return latest.current.registry.actions;
      },
      get helpers() {
        return latest.current.registry.helpers;
      },
      get observers() {
        const p = latest.current;
        return [
          ...p.registry.observers,
          ...(p.observers ?? []),
          ...(client ? [client.observer] : []),
          ...extraObservers,
        ];
      },
      get overlays() {
        return latest.current.overlays ? overlays : undefined;
      },
      get remoteActions() {
        return latest.current.remoteActions;
      },
      navigate: (to, params, options) => {
        const navigate = latest.current.navigate;
        if (!navigate) throw new Error('No navigator: pass `navigate` to <ZyroxProvider>');
        navigate(to, params, options);
      },
      back: (result) => {
        const back = latest.current.back;
        if (!back) throw new Error('No navigator: pass `back` to <ZyroxProvider>');
        back(result);
      },
      openUrl: (url) => (latest.current.openUrl ?? platform.openUrl)(url),
      callFunction: (fn, args, ctx) => {
        const call = latest.current.callFunction ?? client?.callFunction;
        if (!call)
          return Promise.reject(
            new Error('No function caller: set `endpoint` or `callFunction` on <ZyroxProvider>'),
          );
        return call(fn, args, ctx);
      },
      onForeground: (listener) => platform.onForeground(listener),
      i18n,
    }),
    [client, i18n, platform, dataCache, overlays, extraObservers],
  );

  const device = platform.useDevice();
  const app = props.app;
  // Runs actions outside any screen: from your own code, your backend and trigger rules.
  const [appRuntime] = useState(
    () => new ScreenRuntime({ document: APP_DOCUMENT, host, app: app ?? EMPTY_APP, device }),
  );
  useEffect(() => {
    appRuntime.store.set('app', app ?? EMPTY_APP);
    appRuntime.store.set('device', device);
  }, [appRuntime, app, device]);
  useEffect(() => {
    appRuntime.start();
    return () => {
      appRuntime.stop();
      overlays.clear();
    };
  }, [appRuntime, overlays]);

  // Keep the server bootstrap fresh: now, on foreground, and when its TTL expires.
  useEffect(() => {
    if (!client) return;
    const refresh = (force = false) =>
      client.refresh(force).then(
        () => {
          const locales = client.locales();
          if (locales.length) {
            i18n.setAvailable(locales);
            void i18n.ensureLoaded();
          }
        },
        (err) => {
          if (latest.current.debug) console.warn('[zyrox] bootstrap failed', err);
        },
      );
    void refresh();
    const stopForeground = platform.onForeground(() => {
      void refresh();
    });
    const stopBackground = platform.onBackground(() => void client.flush());
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      stopForeground();
      stopBackground();
      clearInterval(timer);
      void client.flush();
    };
  }, [client, i18n, platform]);

  // Controlled locale.
  useEffect(() => {
    if (props.locale && props.locale !== i18n.locale) void i18n.setLocale(props.locale);
  }, [props.locale, i18n]);

  const stable = useMemo<ZyroxStable>(
    () => ({
      registry: props.registry,
      host,
      i18n,
      client,
      mock: Boolean(props.mock),
      debug: Boolean(props.debug),
      inspect: false,
      bundled: (key: string) => latest.current.documents?.[key],
      overlays,
      appRuntime,
      observe: (observer: Observer) => {
        extraObservers.add(observer);
        return () => extraObservers.delete(observer);
      },
      storage: () => latest.current.storage ?? platform.defaultStorage(),
      receiver,
    }),
    [
      props.registry,
      host,
      i18n,
      client,
      props.mock,
      props.debug,
      overlays,
      appRuntime,
      extraObservers,
      platform,
      receiver,
    ],
  );

  const dynamic = useMemo<ZyroxDynamic>(() => ({ app: app ?? EMPTY_APP, device }), [app, device]);

  return (
    <StableContext.Provider value={stable}>
      <DynamicContext.Provider value={dynamic}>
        {props.children}
        {props.overlays ? <OverlayHost controller={overlays} components={props.overlays} /> : null}
      </DynamicContext.Provider>
    </StableContext.Provider>
  );
}

const EMPTY_APP: Record<string, unknown> = {};
const APP_DOCUMENT: Document = { zyrox: 1, kind: 'screen', key: '$app', root: { id: 'root', type: '$app' } };

/** Active language, available languages, text direction and a setter, for your own UI. */
export function useI18n() {
  const { i18n } = useZyrox();
  const snapshot = useSyncExternalStore(i18n.subscribe, i18n.getSnapshot, i18n.getSnapshot);
  return useMemo(
    () => ({
      ...snapshot,
      setLocale: (locale: string) => i18n.setLocale(locale),
      t: i18n.translator(),
      addMessages: (locale: string, messages: Messages) => i18n.addMessages(locale, messages, 'runtime'),
    }),
    [snapshot, i18n],
  );
}
