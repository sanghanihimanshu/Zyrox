import { useQuery } from '@tanstack/react-query';
import type { Problem as CoreProblem } from '@wishyor/zyrox-core/validate';
import { validateDocument } from '@wishyor/zyrox-core/validate';
import type { Document, Manifest } from '@wishyor/zyrox-protocol';
import {
  AlertTriangle,
  ArrowLeft,
  Braces,
  CheckCircle2,
  CloudOff,
  History,
  Loader2,
  QrCode,
  Redo2,
  Rocket,
  Sparkles,
  Terminal,
  Undo2,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Redirect, useParams } from 'wouter';
import { get } from '../lib/api';
import { can, useDocuments, useLatestManifest } from '../lib/queries';
import type { Draft } from '../lib/types';
import { useProjectContext } from '../pages/Layout';
import { Badge, Button, cx, IconButton, Spinner, Tabs } from '../ui';
import { AssistantPanel } from './AssistantPanel';
import { Canvas } from './Canvas';
import { DevicePreview } from './DevicePreview';
import { Inspector } from './Inspector';
import { Outline } from './Outline';
import { Palette } from './Palette';
import { PublishDialog } from './PublishDialog';
import { EditorStore, useEditor } from './store';

const JsonModeDialog = lazy(() => import('./JsonDialogs'));
const VersionsDialog = lazy(() => import('./JsonDialogs').then((m) => ({ default: m.VersionsDialog })));

export interface ConsoleEntry {
  id: number;
  time: number;
  source: string;
  event: Record<string, any>;
}

export function EditorPage() {
  const params = useParams<{ '*': string }>();
  const key = params['*'] ?? '';
  const { project } = useProjectContext();
  const endpoint = `/projects/${project.slug}/documents/${key}`;
  const draft = useQuery({
    queryKey: ['draft', endpoint],
    queryFn: () => get<{ document: { kind: string; title: string }; draft: Draft }>(endpoint),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (draft.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }
  if (!draft.data) {
    return (
      <div className="grid h-full place-items-center text-sm text-zinc-500">
        <p>
          Document not found. <Link href="/">Back</Link>
        </p>
      </div>
    );
  }
  if (draft.data.document.kind === 'strings') return <Redirect to="/strings" />;
  return (
    <Editor
      key={endpoint}
      endpoint={endpoint}
      initial={draft.data.draft.content as Document}
      revision={draft.data.draft.revision}
    />
  );
}

function SaveIndicator({ state, error }: { state: string; error?: string }) {
  if (state === 'saving')
    return (
      <span className="flex items-center gap-1 text-xs text-zinc-500">
        <Loader2 className="size-3 animate-spin" /> Saving
      </span>
    );
  if (state === 'error')
    return (
      <span className="flex items-center gap-1 text-xs text-red-600" title={error}>
        <CloudOff className="size-3" /> Not saved, retrying
      </span>
    );
  if (state === 'conflict')
    return (
      <span className="flex items-center gap-1 text-xs text-red-600" title={error}>
        <AlertTriangle className="size-3" /> Changed elsewhere
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-zinc-400">
      <CheckCircle2 className="size-3" /> Saved
    </span>
  );
}

function Editor({ endpoint, initial, revision }: { endpoint: string; initial: Document; revision: number }) {
  const { project, role, environments } = useProjectContext();
  const [store] = useState(() => new EditorStore(endpoint, initial, revision));
  const snapshot = useEditor(store);
  const { manifest: uploaded } = useLatestManifest(project.slug);
  const [appManifest, setAppManifest] = useState<Manifest | undefined>();
  const manifest = uploaded ?? appManifest;
  const docs = useDocuments(project.slug);
  const blocks = (docs.data?.documents ?? []).filter((d) => d.kind === 'block' && d.latest).map((d) => d.key);
  const [left, setLeft] = useState<'layers' | 'insert'>('layers');
  const [bottom, setBottom] = useState<'problems' | 'console' | null>('problems');
  const [dialog, setDialog] = useState<'publish' | 'json' | 'versions' | 'device' | null>(null);
  const [deviceSession, setDeviceSession] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const aiStatus = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => get<{ enabled: boolean; model: string | null }>('/ai/status'),
    staleTime: 5 * 60_000,
  });
  const [consoleEntries, setConsole] = useState<ConsoleEntry[]>([]);
  const nextId = useRef(0);
  const editable = can(role, 'editor');

  const logEvent = (event: unknown, source: string) => {
    const e = event as Record<string, any>;
    if (!e || e.type === 'screen_view' || e.type === 'screen_load') return;
    setConsole((c) => [...c.slice(-199), { id: nextId.current++, time: Date.now(), source, event: e }]);
  };

  // Validate locally on every change (structure, expressions, the app manifest).
  const [problems, setProblems] = useState<CoreProblem[]>([]);
  useEffect(() => {
    const t = setTimeout(
      () =>
        setProblems(
          validateDocument(snapshot.doc, {
            manifest,
            globals: snapshot.doc.kind === 'block' ? ['input'] : [],
          }).filter((p) => !p.message.startsWith('No published block')),
        ),
      250,
    );
    return () => clearTimeout(t);
  }, [snapshot.doc, manifest]);
  const errorCount = problems.filter((p) => p.level === 'error').length;

  // Undo / redo shortcuts, unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable], .monaco-editor')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const title = snapshot.doc.title || snapshot.doc.key;
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-2 dark:border-zinc-800 dark:bg-zinc-900">
        <Link
          href="/"
          className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Back to documents"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold">{title}</span>
          <span className="truncate font-mono text-[11px] text-zinc-500">
            {snapshot.doc.kind} · {snapshot.doc.key}
          </span>
        </div>
        <div className="ml-3">
          <SaveIndicator state={snapshot.save} error={snapshot.error} />
        </div>
        {snapshot.save === 'conflict' ? (
          <Button size="sm" variant="danger" onClick={() => location.reload()}>
            Reload
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label="Undo (⌘Z)"
            icon={<Undo2 className="size-4" />}
            disabled={!snapshot.canUndo}
            onClick={() => store.undo()}
          />
          <IconButton
            label="Redo (⇧⌘Z)"
            icon={<Redo2 className="size-4" />}
            disabled={!snapshot.canRedo}
            onClick={() => store.redo()}
          />
          <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
          {aiStatus.data?.enabled && editable ? (
            <Button
              size="sm"
              variant={assistant ? 'secondary' : 'ghost'}
              icon={<Sparkles className="size-3.5" />}
              onClick={() => setAssistant((a) => !a)}
            >
              Assistant
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon={<Braces className="size-3.5" />}
            onClick={() => setDialog('json')}
            disabled={!editable}
          >
            JSON
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<History className="size-3.5" />}
            onClick={() => setDialog('versions')}
          >
            History
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<QrCode className="size-3.5" />}
            onClick={() => {
              setDeviceSession(true);
              setDialog('device');
            }}
          >
            Device
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Rocket className="size-3.5" />}
            onClick={() => setDialog('publish')}
          >
            Publish
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <Tabs
            className="px-2 pt-1"
            value={left}
            onChange={setLeft}
            tabs={[
              { value: 'layers', label: 'Layers' },
              { value: 'insert', label: 'Insert' },
            ]}
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {left === 'layers' ? (
              <Outline store={store} manifest={manifest} />
            ) : (
              <Palette store={store} manifest={manifest} blocks={blocks} />
            )}
          </div>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Canvas
              document={snapshot.doc}
              selected={snapshot.selected}
              previewUrl={project.previewUrl}
              projectSlug={project.slug}
              onSelect={(id) => store.select(id)}
              onEvent={(event) => logEvent(event, 'canvas')}
              onManifest={setAppManifest}
            />
          </div>
          <BottomPanel
            tab={bottom}
            onTab={setBottom}
            problems={problems}
            errorCount={errorCount}
            entries={consoleEntries}
            onClear={() => setConsole([])}
            onSelect={(id) => store.select(id)}
          />
        </section>
        <aside
          className={cx(
            'w-80 shrink-0 border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
            !editable && 'pointer-events-none opacity-70',
          )}
        >
          {assistant ? (
            <AssistantPanel
              store={store}
              endpoint={endpoint}
              model={aiStatus.data?.model ?? null}
              onClose={() => setAssistant(false)}
            />
          ) : (
            <Inspector store={store} manifest={manifest} />
          )}
        </aside>
      </div>
      <PublishDialog
        open={dialog === 'publish'}
        onClose={() => setDialog(null)}
        store={store}
        endpoint={endpoint}
        environments={environments}
        role={role}
        projectSlug={project.slug}
        isBlock={snapshot.doc.kind === 'block'}
      />
      {dialog === 'json' || dialog === 'versions' ? (
        <Suspense fallback={null}>
          {dialog === 'json' ? (
            <JsonModeDialog open onClose={() => setDialog(null)} store={store} />
          ) : (
            <VersionsDialog open onClose={() => setDialog(null)} store={store} endpoint={endpoint} />
          )}
        </Suspense>
      ) : null}
      {deviceSession ? (
        <DevicePreview
          open={dialog === 'device'}
          onClose={() => setDialog(null)}
          projectSlug={project.slug}
          document={snapshot.doc}
          previewUrl={project.previewUrl}
          onEvent={(event, device) => logEvent(event, device ?? 'device')}
        />
      ) : null}
    </div>
  );
}

function BottomPanel({
  tab,
  onTab,
  problems,
  errorCount,
  entries,
  onClear,
  onSelect,
}: {
  tab: 'problems' | 'console' | null;
  onTab(t: 'problems' | 'console' | null): void;
  problems: CoreProblem[];
  errorCount: number;
  entries: ConsoleEntry[];
  onClear(): void;
  onSelect(id: string): void;
}) {
  const sorted = useMemo(
    () => [...problems].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)),
    [problems],
  );
  const button = (value: 'problems' | 'console', label: React.ReactNode) => (
    <button
      type="button"
      onClick={() => onTab(tab === value ? null : value)}
      className={cx(
        'flex items-center gap-1.5 px-2 py-1 text-xs',
        tab === value ? 'font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-500',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-1 px-1">
        {button(
          'problems',
          <>
            Problems{' '}
            {errorCount ? (
              <Badge tone="red">{errorCount}</Badge>
            ) : problems.length ? (
              <Badge tone="amber">{problems.length}</Badge>
            ) : (
              <Badge tone="green">0</Badge>
            )}
          </>,
        )}
        {button(
          'console',
          <>
            <Terminal className="size-3" /> Console {entries.length ? <Badge>{entries.length}</Badge> : null}
          </>,
        )}
        {tab === 'console' && entries.length ? (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto px-2 text-xs text-zinc-500 hover:text-zinc-800"
          >
            Clear
          </button>
        ) : null}
      </div>
      {tab ? (
        <div className="h-36 overflow-auto border-t border-zinc-100 font-mono text-[11px] dark:border-zinc-800">
          {tab === 'problems' ? (
            sorted.length ? (
              sorted.map((p, i) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: problems have no ids
                  key={i}
                  type="button"
                  onClick={() => p.nodeId && onSelect(p.nodeId)}
                  className="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <span className={p.level === 'error' ? 'text-red-600' : 'text-amber-600'}>
                    {p.level === 'error' ? '✗' : '!'}
                  </span>
                  {p.nodeId ? <span className="text-indigo-600">#{p.nodeId}</span> : null}
                  <span className="text-zinc-700 dark:text-zinc-300">{p.message}</span>
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-zinc-500">No problems.</p>
            )
          ) : entries.length ? (
            [...entries].reverse().map((entry) => (
              <div key={entry.id} className="flex gap-2 px-3 py-0.5">
                <span className="text-zinc-400">{new Date(entry.time).toLocaleTimeString()}</span>
                <span className="text-zinc-500">{entry.source}</span>
                <span
                  className={
                    entry.event.type === 'error'
                      ? 'text-red-600'
                      : entry.event.type === 'track'
                        ? 'text-indigo-600'
                        : 'text-zinc-700 dark:text-zinc-300'
                  }
                >
                  {entry.event.type}
                  {entry.event.kind ? `:${entry.event.kind}` : ''}
                </span>
                <span className="truncate text-zinc-600 dark:text-zinc-400">
                  {entry.event.message ?? entry.event.action ?? entry.event.name ?? entry.event.key ?? ''}{' '}
                  {entry.event.nodeId ? `#${entry.event.nodeId}` : ''}
                  {entry.event.durationMs !== undefined ? ` ${Math.round(entry.event.durationMs)}ms` : ''}
                </span>
              </div>
            ))
          ) : (
            <p className="px-3 py-2 text-zinc-500">
              Runtime events from the canvas and connected devices show up here. Switch the canvas to interact
              mode to run actions.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
