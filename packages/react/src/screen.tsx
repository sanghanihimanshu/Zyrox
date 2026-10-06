import {
  compileDocument,
  type DocumentStatus,
  type Observer,
  type RuntimeHost,
  ScreenRuntime,
} from '@wishyor/zyrox-core';
import type { Document } from '@wishyor/zyrox-protocol';
import { PROTOCOL_VERSION } from '@wishyor/zyrox-protocol';
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { FrameContext, RuntimeContext, useZyrox, useZyroxDynamic } from './context';
import { NodeView } from './node-view';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface ZyroxScreenProps {
  /** Document key to load from the Zyrox server. */
  screen?: string;
  /** Render this document directly (inline, SSR, tests, preview). */
  document?: Document;
  /** Version ref of an inline document, attached to events. */
  version?: string;
  params?: Record<string, unknown>;
  /** Shown while the document loads. */
  loading?: ReactNode;
  /** Shown when the document can't be loaded or is invalid. */
  fallback?: ReactNode;
  /** Use data source mocks for this screen. */
  mock?: boolean;
  /** Screen-level observer, in addition to the provider's. */
  onEvent?: Observer;
  /**
   * Switch to a newly published version as soon as it arrives. By default a mounted screen keeps
   * the version it opened with, so nothing changes under the user's finger.
   */
  live?: boolean;
}

const NO_CLIENT = () => () => {};

type ScreenSource = 'inline' | 'cache' | 'network' | 'snapshot' | 'bundled';
type Resolved =
  | { status: 'ready'; document: Document; ref: string; source: ScreenSource }
  | Exclude<DocumentStatus, { status: 'ready' }>;

function useServerDocument(key: string | undefined, live: boolean): Resolved | undefined {
  const { client, bundled } = useZyrox();
  const subscribe = client?.subscribe ?? NO_CLIENT;
  const version = useSyncExternalStore(subscribe, client?.getVersion ?? zero, client?.getVersion ?? zero);
  const pinned = useRef<Resolved | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` signals client changes
  return useMemo(() => {
    if (!key) return undefined;
    if (!live && pinned.current?.status === 'ready') return pinned.current;
    const local = bundled(key);
    let status: Resolved = client
      ? client.getDocument(key)
      : { status: 'error', message: 'No Zyrox endpoint configured on the provider' };
    // Shipped with the app: used until (or unless) the server has a version.
    if (status.status !== 'ready' && local)
      status = { status: 'ready', document: local, ref: '', source: 'bundled' };
    if (status.status === 'ready') pinned.current = status;
    return status;
  }, [client, bundled, key, live, version]);
}

function zero() {
  return 0;
}

const documentIds = new WeakMap<Document, number>();
let nextDocumentId = 0;

/** A new document object (e.g. an edit in the dashboard) starts a fresh screen runtime. */
function documentId(document: Document): number {
  let id = documentIds.get(document);
  if (id === undefined) {
    id = ++nextDocumentId;
    documentIds.set(document, id);
  }
  return id;
}

/** Renders a server-driven screen (by key) or an inline document. */
export function ZyroxScreen(props: ZyroxScreenProps): ReactNode {
  const fromServer = useServerDocument(props.document ? undefined : props.screen, Boolean(props.live));
  let document: Document | undefined = props.document;
  let version = props.version;
  let source: ScreenSource = 'inline';
  if (!document && fromServer) {
    if (fromServer.status === 'ready') {
      document = fromServer.document;
      version = fromServer.ref || undefined;
      source = fromServer.source;
    } else if (fromServer.status === 'loading') {
      return props.loading ?? null;
    } else {
      return props.fallback ?? null;
    }
  }
  if (!document) return props.fallback ?? null;
  if (document.zyrox !== PROTOCOL_VERSION) return props.fallback ?? null;
  return (
    <ScreenBody
      key={`${document.key}:${version ?? ''}:${documentId(document)}`}
      {...props}
      document={document}
      version={version}
      source={source}
    />
  );
}

interface ScreenBodyProps extends ZyroxScreenProps {
  document: Document;
  source: ScreenSource;
}

function ScreenBody(props: ScreenBodyProps): ReactNode {
  const { host, mock, client } = useZyrox();
  const { app, device } = useZyroxDynamic();
  const onEvent = useRef(props.onEvent);
  onEvent.current = props.onEvent;
  const mounted = useRef(Date.now());

  const [runtime] = useState(() => {
    const screenHost: RuntimeHost = Object.create(host, {
      mock: { get: () => Boolean(props.mock ?? mock ?? host.mock) },
      observers: {
        get: () => [...(host.observers ?? []), ...(onEvent.current ? [onEvent.current] : [])],
      },
    });
    return new ScreenRuntime({
      document: compileDocument(props.document),
      params: props.params,
      host: screenHost,
      version: props.version,
      app,
      device,
    });
  });

  useIsomorphicLayoutEffect(() => {
    runtime.setRoot('params', { ...(runtime.store.get('params') as object), ...props.params });
  }, [runtime, props.params]);
  useIsomorphicLayoutEffect(() => runtime.setRoot('app', app), [runtime, app]);
  useIsomorphicLayoutEffect(() => runtime.setRoot('device', device), [runtime, device]);

  useEffect(() => {
    runtime.start();
    return () => runtime.stop();
  }, [runtime]);

  useEffect(() => {
    runtime.emit({
      type: 'screen_view',
      params: (runtime.store.get('params') as Record<string, unknown>) ?? {},
    });
    runtime.emit({ type: 'screen_load', durationMs: Date.now() - mounted.current, source: props.source });
    for (const experiment of client?.getBootstrap()?.experiments ?? []) {
      if (experiment.docs.includes(runtime.key)) {
        runtime.emit({ type: 'exposure', experiment: experiment.key, variant: experiment.variant });
      }
    }
  }, [runtime, client, props.source]);

  return (
    <RuntimeContext.Provider value={runtime}>
      <FrameContext.Provider value={null}>
        <NodeView node={runtime.doc.root} />
      </FrameContext.Provider>
    </RuntimeContext.Provider>
  );
}
