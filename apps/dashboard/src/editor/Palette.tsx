import type { Manifest } from '@zyrox/protocol';
import { Blocks, Box, Search } from 'lucide-react';
import { useState } from 'react';
import { Input, useToast } from '../ui';
import { insertionFor, newNode } from './create';
import { NEW_NODE_MIME } from './Outline';
import { type EditorStore, useEditor } from './store';

export function Palette({
  store,
  manifest,
  blocks,
}: {
  store: EditorStore;
  manifest?: Manifest;
  blocks: string[];
}) {
  const snapshot = useEditor(store);
  const toast = useToast();
  const [query, setQuery] = useState('');
  const q = query.toLowerCase();
  const components = Object.entries(manifest?.components ?? {}).filter(([name, c]) =>
    (name + (c.description ?? '')).toLowerCase().includes(q),
  );
  const blockItems = blocks.filter((b) => b !== snapshot.doc.key && b.toLowerCase().includes(q));
  const insert = (type: string) => {
    const node = newNode(snapshot.doc, type, manifest);
    const at = insertionFor(snapshot.doc, snapshot.selected, manifest);
    const error = store.tryApply([{ op: 'insert', ...at, node }], { label: `Add ${type}`, select: node.id });
    if (error) toast(error, 'error');
  };
  const item = (type: string, label: string, description: string | undefined, icon: React.ReactNode) => (
    <button
      key={type}
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(NEW_NODE_MIME, type);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => insert(type)}
      title={description}
      aria-label={`Add ${label}`}
      className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      <span className="mt-0.5 text-zinc-400">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        {description ? (
          <span className="line-clamp-2 block text-[11px] text-zinc-500">{description}</span>
        ) : null}
      </span>
    </button>
  );
  return (
    <div className="flex flex-col gap-1 p-2">
      <div className="relative mb-1">
        <Search className="absolute top-2 left-2 size-3.5 text-zinc-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a component"
          className="h-8 pl-7 text-xs"
          aria-label="Find a component"
        />
      </div>
      {!manifest ? (
        <p className="px-2 py-1 text-xs text-zinc-500">Upload your app manifest to list your components.</p>
      ) : null}
      {components.map(([name, c]) => item(name, name, c.description, <Box className="size-3.5" />))}
      {blockItems.length ? (
        <p className="mt-2 px-2 text-[11px] font-medium text-zinc-400 uppercase">Blocks</p>
      ) : null}
      {blockItems.map((key) => item(`@block/${key}`, key, 'Reusable block', <Blocks className="size-3.5" />))}
    </div>
  );
}
