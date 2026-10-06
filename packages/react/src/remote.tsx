import {
  parseUiMessage,
  UiActionCenter,
  type UiActionSource,
  type UiMessage,
  type UiTrigger,
} from '@zyrox/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useZyrox } from './context';
import { getPlatform, type ZyroxStorage } from './platform-api';

export type {
  ReconnectOptions,
  SseSourceOptions,
  UiActionSource,
  UiMessage,
  UiTrigger,
  WebSocketSourceOptions,
} from '@zyrox/core';
export {
  createSseParser,
  parseUiMessage,
  pollSource,
  sseSource,
  UiActionCenter,
  webSocketSource,
} from '@zyrox/core';

export interface ZyroxRemoteProps {
  /**
   * Where your backend's messages come from: `sseSource(…)`, `webSocketSource(…)`, `pollSource(…)`
   * or your own (push notifications, Firebase, Pusher, Socket.IO…). Read when mounted: give
   * `<ZyroxRemote>` a `key` (e.g. the user id) to reconnect with new ones.
   */
  sources?: readonly UiActionSource[];
  /**
   * Event-trigger rules: a list, a URL fetched with your fetcher (an array, or `{ triggers }`),
   * or a loader. Reloaded when the app returns to the foreground.
   */
  triggers?: readonly UiTrigger[] | string | (() => Promise<unknown>);
  /** Remembers message ids and `once`/`cooldown` triggers. Default: the provider's storage. */
  storage?: ZyroxStorage;
  /** Every accepted message (logging). */
  onMessage?(message: UiMessage): void;
}

/**
 * Lets your backend drive UI: messages from `sources` and event-trigger rules run sheets, alerts,
 * toasts, redirects and allowed app actions. Render it once, inside `<ZyroxProvider>`.
 */
export function ZyroxRemote(props: ZyroxRemoteProps): ReactNode {
  const { appRuntime, observe, storage, receiver } = useZyrox();
  const latest = useRef(props);
  latest.current = props;
  const [center] = useState(
    () =>
      new UiActionCenter({
        runtime: appRuntime,
        storage: props.storage ?? storage(),
        onMessage: (message) => latest.current.onMessage?.(message),
      }),
  );

  useEffect(() => {
    const stopObserving = observe(center.observer);
    receiver.current = async (message) => {
      await center.receive(message);
      return true;
    };
    const disconnect = (latest.current.sources ?? []).map((source) =>
      source((message) => void center.receive(message)),
    );
    let cancelled = false;
    const load = async () => {
      const triggers = latest.current.triggers;
      if (!triggers) return;
      try {
        const value =
          typeof triggers === 'string'
            ? await appRuntime.fetch({ url: triggers, method: 'GET', headers: {}, source: 'request' })
            : typeof triggers === 'function'
              ? await triggers()
              : triggers;
        const list = Array.isArray(value) ? (value as UiTrigger[]) : parseUiMessage(value)?.triggers;
        if (list && !cancelled) center.setTriggers(list);
      } catch (err) {
        appRuntime.emit({
          type: 'error',
          kind: 'data',
          message: `Trigger rules: ${err instanceof Error ? err.message : String(err)}`,
          source: 'triggers',
        });
      }
    };
    void load().then(() => {
      if (!cancelled) center.appOpen();
    });
    const stopForeground = getPlatform().onForeground(() => {
      center.foreground();
      void load();
    });
    return () => {
      cancelled = true;
      stopObserving();
      stopForeground();
      for (const stop of disconnect) stop();
      center.stop();
      receiver.current = undefined;
    };
  }, [center, observe, receiver, appRuntime]);

  return null;
}
