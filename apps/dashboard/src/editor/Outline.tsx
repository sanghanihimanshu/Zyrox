import { findNode } from '@zyrox/core';
import type { Document, Manifest, Node, Op, SlotRef } from '@zyrox/protocol';
import { ChevronDown, ChevronRight, Copy, Eye, Layers, Repeat, Trash2, Zap } from 'lucide-react';
import { type DragEvent, useMemo, useState } from 'react';
import { cx, IconButton, useToast } from '../ui';
import { acceptsChildren, duplicateOps, newNode } from './create';
import { type EditorStore, useEditor } from './store';

export const NEW_NODE_MIME = 'application/x-zyrox-new';
const MOVE_MIME = 'application/x-zyrox-node';

type Row =
  | {
      kind: 'node';
      node: Node;
      depth: number;
      parent: string | null;
      slot: SlotRef;
      index: number;
      hasChildren: boolean;
    }
  | {
      kind: 'group';
      key: string;
      parent: string;
      slot: SlotRef;
      label: string;
      depth: number;
      empty: boolean;
    };

function buildRows(doc: Document, collapsed: Set<string>, manifest?: Manifest): Row[] {
  const rows: Row[] = [];
  const visit = (node: Node, depth: number, parent: string | null, slot: SlotRef, index: number) => {
    const component = manifest?.components[node.type];
    const slotNames = [...new Set([...(component?.slots ?? []), ...Object.keys(node.slots ?? {})])];
    const templateNames = [
      ...new Set([...(component?.templates ?? []), ...Object.keys(node.templates ?? {})]),
    ];
    const hasChildren = Boolean(
      node.children?.length || slotNames.length || templateNames.length || node.fallback,
    );
    rows.push({ kind: 'node', node, depth, parent, slot, index, hasChildren });
    if (collapsed.has(node.id)) return;
    for (const [i, child] of (node.children ?? []).entries()) visit(child, depth + 1, node.id, 'children', i);
    for (const name of slotNames) {
      const list = node.slots?.[name] ?? [];
      rows.push({
        kind: 'group',
        key: `${node.id}:slots.${name}`,
        parent: node.id,
        slot: `slots.${name}`,
        label: `slot · ${name}`,
        depth: depth + 1,
        empty: !list.length,
      });
      for (const [i, child] of list.entries()) visit(child, depth + 2, node.id, `slots.${name}`, i);
    }
    for (const name of templateNames) {
      const template = node.templates?.[name];
      rows.push({
        kind: 'group',
        key: `${node.id}:templates.${name}`,
        parent: node.id,
        slot: `templates.${name}`,
        label: `template · ${name}`,
        depth: depth + 1,
        empty: !template,
      });
      if (template) visit(template, depth + 2, node.id, `templates.${name}`, 0);
    }
    if (node.fallback) {
      rows.push({
        kind: 'group',
        key: `${node.id}:fallback`,
        parent: node.id,
        slot: 'fallback',
        label: 'fallback',
        depth: depth + 1,
        empty: false,
      });
      visit(node.fallback, depth + 2, node.id, 'fallback', 0);
    }
  };
  visit(doc.root, 0, null, 'children', 0);
  return rows;
}

type DropPosition = 'before' | 'after' | 'inside';

export function Outline({ store, manifest }: { store: EditorStore; manifest?: Manifest }) {
  const snapshot = useEditor(store);
  const toast = useToast();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drop, setDrop] = useState<{ key: string; position: DropPosition } | null>(null);
  const rows = useMemo(
    () => buildRows(snapshot.doc, collapsed, manifest),
    [snapshot.doc, collapsed, manifest],
  );

  const apply = (ops: Op[], label: string, select?: string) => {
    const error = store.tryApply(ops, { label, select });
    if (error) toast(error, 'error');
  };

  const target = (
    row: Row,
    position: DropPosition,
  ): { parent: string; slot: SlotRef; index?: number } | null => {
    if (row.kind === 'group') return { parent: row.parent, slot: row.slot };
    if (position === 'inside')
      return acceptsChildren(row.node, manifest) ? { parent: row.node.id, slot: 'children' } : null;
    if (!row.parent || row.slot === 'fallback' || row.slot.startsWith('templates.')) return null;
    return { parent: row.parent, slot: row.slot, index: row.index + (position === 'after' ? 1 : 0) };
  };

  const onDragOver = (e: DragEvent, row: Row) => {
    if (!e.dataTransfer.types.includes(NEW_NODE_MIME) && !e.dataTransfer.types.includes(MOVE_MIME)) return;
    e.preventDefault();
    let position: DropPosition = 'inside';
    if (row.kind === 'node') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const y = (e.clientY - rect.top) / rect.height;
      position =
        y < 0.3
          ? 'before'
          : y > 0.7
            ? 'after'
            : acceptsChildren(row.node, manifest)
              ? 'inside'
              : y < 0.5
                ? 'before'
                : 'after';
      if (!row.parent) position = 'inside';
    }
    const key = row.kind === 'node' ? row.node.id : row.key;
    if (drop?.key !== key || drop.position !== position) setDrop({ key, position });
  };

  const onDrop = (e: DragEvent, row: Row) => {
    e.preventDefault();
    const position = drop?.position ?? 'inside';
    setDrop(null);
    const t = target(row, position);
    if (!t) return;
    const type = e.dataTransfer.getData(NEW_NODE_MIME);
    if (type) {
      const node = newNode(snapshot.doc, type, manifest);
      apply([{ op: 'insert', parent: t.parent, slot: t.slot, index: t.index, node }], `Add ${type}`, node.id);
      return;
    }
    const id = e.dataTransfer.getData(MOVE_MIME);
    if (!id) return;
    const from = findNode(snapshot.doc, id);
    let index = t.index;
    if (from?.parent?.id === t.parent && from.slot === t.slot && index !== undefined && from.index < index)
      index -= 1;
    apply([{ op: 'move', id, parent: t.parent, slot: t.slot, index }], 'Move');
  };

  const remove = (id: string) => apply([{ op: 'remove', id }], 'Delete');
  const duplicate = (id: string) => {
    const dup = duplicateOps(snapshot.doc, id);
    if (dup) apply(dup.ops, 'Duplicate', dup.newId);
  };

  return (
    <div
      className="flex flex-col py-1 text-[13px] outline-none"
      role="tree"
      aria-label="Outline"
      tabIndex={0}
      onKeyDown={(e) => {
        const selected = snapshot.selected;
        if (!selected) return;
        const nodeRows = rows.filter((r): r is Extract<Row, { kind: 'node' }> => r.kind === 'node');
        const i = nodeRows.findIndex((r) => r.node.id === selected);
        if (e.key === 'ArrowDown' && i < nodeRows.length - 1) store.select(nodeRows[i + 1]!.node.id);
        else if (e.key === 'ArrowUp' && i > 0) store.select(nodeRows[i - 1]!.node.id);
        else if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== snapshot.doc.root.id)
          remove(selected);
        else if (e.key === 'd' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          duplicate(selected);
        } else return;
        e.preventDefault();
      }}
    >
      {rows.map((row) => {
        if (row.kind === 'group') {
          const active = drop?.key === row.key;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a drop zone row inside the tree
            <div
              key={row.key}
              role="group"
              aria-label={row.label}
              onDragOver={(e) => onDragOver(e, row)}
              onDragLeave={() => setDrop(null)}
              onDrop={(e) => onDrop(e, row)}
              style={{ paddingLeft: 8 + row.depth * 14 }}
              className={cx(
                'flex h-6 items-center gap-1 pr-2 text-[11px] text-zinc-400 uppercase',
                active && 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950',
              )}
            >
              <Layers className="size-3" />
              {row.label}
              {row.empty ? <span className="normal-case">(drop here)</span> : null}
            </div>
          );
        }
        const { node } = row;
        const selected = snapshot.selected === node.id;
        const isRoot = row.parent === null;
        const indicator = drop?.key === node.id ? drop.position : null;
        const known = !manifest || manifest.components[node.type] || node.type.startsWith('@block/');
        return (
          // Keyboard navigation is handled by the tree container (arrows, delete, ⌘D).
          // biome-ignore lint/a11y/useKeyWithClickEvents: see above
          <div
            key={node.id}
            role="treeitem"
            tabIndex={-1}
            aria-selected={selected}
            aria-label={`${node.type} ${node.id}`}
            draggable={!isRoot}
            onDragStart={(e) => {
              e.dataTransfer.setData(MOVE_MIME, node.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => onDragOver(e, row)}
            onDragLeave={() => setDrop(null)}
            onDrop={(e) => onDrop(e, row)}
            onClick={() => store.select(node.id)}
            style={{ paddingLeft: 4 + row.depth * 14 }}
            className={cx(
              'group relative flex h-7 cursor-default items-center gap-1 pr-1',
              selected
                ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100'
                : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
              indicator === 'inside' && 'ring-2 ring-indigo-400 ring-inset',
            )}
          >
            {indicator === 'before' ? (
              <span className="absolute inset-x-0 top-0 h-0.5 bg-indigo-500" />
            ) : null}
            {indicator === 'after' ? (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-indigo-500" />
            ) : null}
            <button
              type="button"
              aria-label={collapsed.has(node.id) ? 'Expand' : 'Collapse'}
              className={cx('grid size-4 place-items-center text-zinc-400', !row.hasChildren && 'invisible')}
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                });
              }}
            >
              {collapsed.has(node.id) ? (
                <ChevronRight className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </button>
            <span className={cx('font-medium', !known && 'text-red-600 line-through decoration-red-300')}>
              {node.type.replace('@block/', '▣ ')}
            </span>
            <span className="truncate font-mono text-[11px] text-zinc-400">#{node.id}</span>
            <span className="ml-auto flex items-center gap-0.5 text-zinc-400">
              {node.if !== undefined ? <Eye className="size-3" aria-label="conditional" /> : null}
              {node.repeat ? <Repeat className="size-3" aria-label="repeated" /> : null}
              {node.on && Object.keys(node.on).length ? (
                <Zap className="size-3" aria-label="has events" />
              ) : null}
            </span>
            {!isRoot ? (
              <span className="hidden items-center group-hover:flex">
                <IconButton
                  label="Duplicate"
                  icon={<Copy className="size-3" />}
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicate(node.id);
                  }}
                />
                <IconButton
                  label="Delete"
                  icon={<Trash2 className="size-3" />}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(node.id);
                  }}
                />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
