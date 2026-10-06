import type { Problem } from '@wishyor/zyrox-core/validate';
import type { Op } from '@wishyor/zyrox-protocol';
import { ImagePlus, Send, Sparkles, Square, Undo2, X } from 'lucide-react';
import { type ClipboardEvent, useRef, useState } from 'react';
import { Button, cx, IconButton, Textarea } from '../ui';
import type { EditorStore } from './store';

type Item =
  | { kind: 'user'; text: string; image?: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'ops'; summary: string; count: number; failed?: string }
  | { kind: 'problems'; count: number }
  | { kind: 'error'; text: string };

type ServerEvent =
  | { type: 'text'; text: string }
  | { type: 'ops'; ops: Op[]; summary: string }
  | { type: 'problems'; problems: Problem[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUGGESTIONS = [
  'Add a loading skeleton and an empty state',
  'Make this screen work in dark mode and right-to-left',
  'Turn the list into a 2-column grid on wide screens',
];

/** Chat with Claude about the open document; its edits arrive as ops (each one undoable). */
export function AssistantPanel({
  store,
  endpoint,
  model,
  onClose,
}: {
  store: EditorStore;
  endpoint: string;
  model: string | null;
  onClose(): void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [prompt, setPrompt] = useState('');
  const [image, setImage] = useState<{ mediaType: string; data: string; url: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [applied, setApplied] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const push = (item: Item) =>
    setItems((list) => {
      const last = list.at(-1);
      // Stream text into the current assistant message.
      if (item.kind === 'assistant' && last?.kind === 'assistant')
        return [...list.slice(0, -1), { kind: 'assistant', text: last.text + item.text }];
      return [...list, item];
    });

  const attach = (blob: Blob | undefined | null) => {
    if (!blob || !/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) return;
    if (blob.size > MAX_IMAGE_BYTES) {
      push({ kind: 'error', text: 'Images must be under 5 MB.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      setImage({ mediaType: blob.type, data: url.slice(url.indexOf(',') + 1), url });
    };
    reader.readAsDataURL(blob);
  };

  const onPaste = (e: ClipboardEvent) => {
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      attach(item.getAsFile());
    }
  };

  const send = async (text = prompt) => {
    if (!text.trim() || running) return;
    await store.settled();
    push({ kind: 'user', text, image: image?.url });
    setPrompt('');
    setRunning(true);
    setApplied(0);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const res = await fetch(`/api${endpoint}/ai`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          document: store.doc,
          ...(image ? { image: { mediaType: image.mediaType, data: image.data } } : {}),
        }),
        signal: controller.signal,
      });
      setImage(null);
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) handle(JSON.parse(line) as ServerEvent);
      }
    } catch (err) {
      if (!controller.signal.aborted)
        push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  const handle = (event: ServerEvent) => {
    if (event.type === 'text') push({ kind: 'assistant', text: event.text });
    else if (event.type === 'ops') {
      const failed = store.tryApply(event.ops, { label: `AI: ${event.summary}` }) ?? undefined;
      if (!failed) setApplied((n) => n + 1);
      push({ kind: 'ops', summary: event.summary, count: event.ops.length, failed });
    } else if (event.type === 'problems' && event.problems.length)
      push({ kind: 'problems', count: event.problems.length });
    else if (event.type === 'error') push({ kind: 'error', text: event.message });
  };

  const undoAll = () => {
    for (let i = 0; i < applied; i++) store.undo();
    setApplied(0);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <Sparkles className="size-4 text-indigo-500" />
        <span className="text-sm font-medium">Assistant</span>
        {model ? <span className="truncate font-mono text-[10px] text-zinc-400">{model}</span> : null}
        <IconButton
          className="ml-auto"
          label="Close assistant"
          icon={<X className="size-4" />}
          onClick={onClose}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 text-sm">
        {items.length === 0 ? (
          <div className="space-y-2 text-xs text-zinc-500">
            <p>
              Describe a change, or paste a screenshot or mockup to build from. Edits use your app's
              components and appear on the canvas; each one can be undone.
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="block w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => void send(s)}
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript
          <div key={i}>
            {item.kind === 'user' ? (
              <div className="ml-6 rounded-lg bg-indigo-50 px-2.5 py-1.5 dark:bg-indigo-950">
                {item.image ? (
                  <img src={item.image} alt="Attached" className="mb-1 max-h-24 rounded" />
                ) : null}
                {item.text}
              </div>
            ) : item.kind === 'assistant' ? (
              <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{item.text}</p>
            ) : item.kind === 'ops' ? (
              <p className={cx('text-xs', item.failed ? 'text-red-600' : 'text-emerald-600')}>
                {item.failed ? `✗ Not applied (${item.failed})` : '✓'} {item.summary} · {item.count} op
                {item.count === 1 ? '' : 's'}
              </p>
            ) : item.kind === 'problems' ? (
              <p className="text-xs text-amber-600">
                {item.count} problem{item.count === 1 ? '' : 's'}, fixing…
              </p>
            ) : (
              <p className="text-xs text-red-600">{item.text}</p>
            )}
          </div>
        ))}
        {running ? <p className="animate-pulse text-xs text-zinc-400">Working…</p> : null}
        {!running && applied ? (
          <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={undoAll}>
            Undo these changes
          </Button>
        ) : null}
      </div>
      <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
        {image ? (
          <div className="relative mb-2 inline-block">
            <img src={image.url} alt="Attachment" className="max-h-20 rounded border border-zinc-200" />
            <button
              type="button"
              aria-label="Remove image"
              className="absolute -top-1.5 -right-1.5 rounded-full bg-zinc-800 p-0.5 text-white"
              onClick={() => setImage(null)}
            >
              <X className="size-3" />
            </button>
          </div>
        ) : null}
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          placeholder="Ask for a change… (paste an image to build from it)"
          aria-label="Message the assistant"
          className="text-sm"
        />
        <div className="mt-1.5 flex items-center gap-1">
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => attach(e.target.files?.[0])}
          />
          <IconButton
            label="Attach image"
            icon={<ImagePlus className="size-4" />}
            onClick={() => file.current?.click()}
          />
          {running ? (
            <Button
              size="sm"
              className="ml-auto"
              icon={<Square className="size-3.5" />}
              onClick={() => abort.current?.abort()}
            >
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              className="ml-auto"
              icon={<Send className="size-3.5" />}
              disabled={!prompt.trim()}
              onClick={() => void send()}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
