import { DiffEditor, Editor } from '@monaco-editor/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Document } from '@zyrox/protocol';
import { documentJsonSchema, documentSchema } from '@zyrox/protocol';
import { useState } from 'react';
import { get, post } from '../lib/api';
import { Badge, Button, cx, Dialog, errorMessage, timeAgo, useToast } from '../ui';
import { jsonDefaults } from './monaco';
import type { EditorStore } from './store';

const dark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
let schemaRegistered = false;

function registerSchema() {
  if (schemaRegistered) return;
  schemaRegistered = true;
  jsonDefaults.setDiagnosticsOptions({
    validate: true,
    schemas: [
      { uri: 'https://zyrox.dev/schema/document.json', fileMatch: ['*'], schema: documentJsonSchema() },
    ],
  });
}

/** Edit the whole document as JSON, with schema validation and autocomplete. */
export default function JsonModeDialog({
  open,
  onClose,
  store,
}: {
  open: boolean;
  onClose(): void;
  store: EditorStore;
}) {
  const [initial] = useState(() => JSON.stringify(store.doc, null, 2));
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  registerSchema();
  const apply = () => {
    try {
      const parsed = documentSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
        return;
      }
      store.replace(parsed.data as Document);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Edit as JSON"
      footer={
        <>
          {error ? (
            <pre className="mr-auto max-w-md overflow-auto text-xs whitespace-pre-wrap text-red-600">
              {error}
            </pre>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <div className="h-[60vh] overflow-hidden rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
        <Editor
          height="100%"
          defaultLanguage="json"
          path="document.json"
          defaultValue={initial}
          theme={dark ? 'vs-dark' : 'vs'}
          onChange={(v) => setText(v ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            tabSize: 2,
            scrollBeyondLastLine: false,
            quickSuggestions: { other: true, comments: false, strings: true },
            suggestOnTriggerCharacters: true,
            wordBasedSuggestions: 'off',
          }}
        />
      </div>
    </Dialog>
  );
}

interface VersionRow {
  id: string;
  number: number;
  ref: string;
  message: string;
  author: string | null;
  createdAt: string;
}

/** Version history: diff any version against the draft and restore it. */
export function VersionsDialog({
  open,
  onClose,
  store,
  endpoint,
}: {
  open: boolean;
  onClose(): void;
  store: EditorStore;
  endpoint: string;
}) {
  const toast = useToast();
  const versions = useQuery({
    queryKey: ['versions', endpoint],
    queryFn: () => get<{ versions: VersionRow[] }>(`${endpoint}/versions`),
    enabled: open,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const number = selected ?? versions.data?.versions[0]?.number ?? null;
  const version = useQuery({
    queryKey: ['version', endpoint, number],
    queryFn: () => get<{ version: { source: unknown } }>(`${endpoint}/versions/${number}`),
    enabled: open && number !== null,
  });
  const restore = useMutation({
    mutationFn: () =>
      post<{ draft: { content: Document; revision: number } }>(`${endpoint}/versions/${number}/restore`),
    onSuccess: (res) => {
      store.reset(res.draft.content, res.draft.revision);
      toast(`Restored version ${number} into the draft`, 'success');
      onClose();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Version history"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={number === null}
            loading={restore.isPending}
            onClick={() => restore.mutate()}
          >
            Restore v{number} to draft
          </Button>
        </>
      }
    >
      {versions.data?.versions.length ? (
        <div className="flex gap-3">
          <div className="flex w-48 shrink-0 flex-col gap-1">
            {versions.data.versions.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setSelected(v.number)}
                className={cx(
                  'rounded-lg px-2 py-1.5 text-left text-xs',
                  number === v.number
                    ? 'bg-indigo-50 dark:bg-indigo-950'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
              >
                <div className="flex items-center gap-1 font-medium">
                  v{v.number} <Badge>{v.ref.slice(2, 9)}</Badge>
                </div>
                <div className="truncate text-zinc-500">{v.message || 'No message'}</div>
                <div className="text-zinc-400">
                  {v.author ?? 'unknown'} · {timeAgo(v.createdAt)}
                </div>
              </button>
            ))}
          </div>
          <div className="h-[55vh] min-w-0 flex-1 overflow-hidden rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
            {version.data ? (
              <DiffEditor
                height="100%"
                language="json"
                original={JSON.stringify(version.data.version.source, null, 2)}
                modified={JSON.stringify(store.doc, null, 2)}
                theme={dark ? 'vs-dark' : 'vs'}
                options={{
                  readOnly: true,
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                }}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">{versions.isLoading ? 'Loading…' : 'Nothing published yet.'}</p>
      )}
      <p className="mt-2 text-xs text-zinc-500">Left: the selected version. Right: your current draft.</p>
    </Dialog>
  );
}
