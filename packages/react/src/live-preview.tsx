import type { Observer } from '@zyrox/core';
import type { Document } from '@zyrox/protocol';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { StableContext, useZyrox } from './context';
import { getPlatform } from './platform-api';
import { ZyroxScreen } from './screen';

export interface PreviewLink {
  /** Zyrox server base URL. */
  server: string;
  session: string;
  token: string;
}

/**
 * Reads a live-preview link from the dashboard QR code, e.g.
 * `myapp://zyrox-preview?server=https%3A%2F%2Fui.example.com&session=prv_…&token=…`
 * or any URL with those query parameters. Returns `null` for other links.
 */
export function parsePreviewLink(url: string): PreviewLink | null {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0]! : '';
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0)
      params.set(
        decodeURIComponent(pair.slice(0, eq)),
        decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')),
      );
  }
  const server = params.get('server');
  const session = params.get('session');
  const token = params.get('token');
  if (!url.includes('zyrox-preview') || !server || !session || !token) return null;
  return { server, session, token };
}

export interface ZyroxLivePreviewProps extends PreviewLink {
  loading?: ReactNode;
  /** Called when the dashboard ends the session or the connection fails. */
  onClose?(): void;
}

/**
 * Shows the draft being edited in the dashboard, updated live. Render it (inside your
 * `ZyroxProvider`) when your app opens a preview link from `parsePreviewLink`.
 */
export function ZyroxLivePreview({
  server,
  session,
  token,
  loading,
  onClose,
}: ZyroxLivePreviewProps): ReactNode {
  const stable = useZyrox();
  const [state, setState] = useState<{ document?: Document; mock: boolean; revision: number }>({
    mock: true,
    revision: 0,
  });
  const socket = useRef<WebSocket | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const url = `${server.replace(/^http/, 'ws').replace(/\/+$/, '')}/v1/preview/${encodeURIComponent(session)}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    socket.current = ws;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'hello',
          platform: getPlatform().name,
          manifest: stable.registry.manifest.hash,
        }),
      );
    ws.onmessage = (message) => {
      try {
        const data = JSON.parse(String(message.data)) as {
          type: string;
          document?: Document;
          mock?: boolean;
        };
        if (data.type === 'document' && data.document) {
          setState((s) => ({ document: data.document, mock: data.mock ?? s.mock, revision: s.revision + 1 }));
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => onCloseRef.current?.();
    return () => {
      socket.current = null;
      ws.close();
    };
  }, [server, session, token, stable.registry]);

  // Forward runtime events (errors, actions, tracks) to the dashboard console.
  const forward = useMemo<Observer>(
    () => (event) => {
      const ws = socket.current;
      if (ws && ws.readyState === 1 && event.type !== 'log')
        ws.send(JSON.stringify({ type: 'event', event }));
    },
    [],
  );

  const previewStable = useMemo(() => ({ ...stable, mock: state.mock }), [stable, state.mock]);
  if (!state.document) return loading ?? null;
  return (
    <StableContext.Provider value={previewStable}>
      <ZyroxScreen key={state.revision} document={state.document} version="preview" onEvent={forward} />
    </StableContext.Provider>
  );
}
