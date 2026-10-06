import { applyOps, findNode, OpError } from '@zyrox/core';
import type { Document, Op } from '@zyrox/protocol';
import { useSyncExternalStore } from 'react';
import { ApiError, post } from '../lib/api';

export type SaveState = 'saved' | 'saving' | 'error' | 'conflict';

export interface EditorSnapshot {
  doc: Document;
  revision: number;
  selected: string | null;
  canUndo: boolean;
  canRedo: boolean;
  save: SaveState;
  error?: string;
  /** Bumped on every change, handy for effects. */
  version: number;
}

interface HistoryEntry {
  ops: Op[];
  inverse: Op[];
  label?: string;
}

/**
 * Editor state: the local document, selection, undo/redo, and a save queue that sends ops to the
 * server in order (batching while a request is in flight) with optimistic locking.
 */
export class EditorStore {
  private state: EditorSnapshot;
  private readonly listeners = new Set<() => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private pending: Op[] = [];
  private inFlight = false;

  constructor(
    private readonly endpoint: string,
    doc: Document,
    revision: number,
    private readonly send: (path: string, body: unknown) => Promise<{ draft: { revision: number } }> = (
      path,
      body,
    ) => post(path, body),
  ) {
    this.state = {
      doc,
      revision,
      selected: doc.root.id,
      canUndo: false,
      canRedo: false,
      save: 'saved',
      version: 0,
    };
  }

  getSnapshot = (): EditorSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<EditorSnapshot>): void {
    this.state = {
      ...this.state,
      ...patch,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      version: this.state.version + 1,
    };
    for (const l of [...this.listeners]) l();
  }

  get doc(): Document {
    return this.state.doc;
  }

  select(id: string | null): void {
    if (id !== this.state.selected) this.set({ selected: id });
  }

  /** Applies ops locally, records undo, and queues them for saving. Throws `OpError` if invalid. */
  apply(ops: Op[], options: { label?: string; select?: string | null } = {}): void {
    if (!ops.length) return;
    const { doc, inverse } = applyOps(this.state.doc, ops);
    this.undoStack.push({ ops, inverse, label: options.label });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.commit(doc, ops, options.select);
  }

  /** Like `apply`, but returns an error message instead of throwing. */
  tryApply(ops: Op[], options: { label?: string; select?: string | null } = {}): string | null {
    try {
      this.apply(ops, options);
      return null;
    } catch (err) {
      return err instanceof OpError ? err.message : String(err);
    }
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    const { doc } = applyOps(this.state.doc, entry.inverse);
    this.redoStack.push(entry);
    this.commit(doc, entry.inverse);
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    const { doc } = applyOps(this.state.doc, entry.ops);
    this.undoStack.push(entry);
    this.commit(doc, entry.ops);
  }

  private commit(doc: Document, ops: Op[], select?: string | null): void {
    let selected = select === undefined ? this.state.selected : select;
    if (selected && !findNode(doc, selected)) selected = doc.root.id;
    this.pending.push(...ops);
    this.set({ doc, selected, save: 'saving' });
    void this.flush();
  }

  /** Replaces the whole document (JSON mode, AI, restore). */
  replace(doc: Document, label = 'Edit JSON'): void {
    this.apply([{ op: 'replace', document: doc }], { label });
  }

  /** Reloads from the server, dropping local history (after a conflict). */
  reset(doc: Document, revision: number): void {
    this.undoStack = [];
    this.redoStack = [];
    this.pending = [];
    this.set({ doc, revision, save: 'saved', error: undefined });
  }

  async flush(): Promise<void> {
    if (this.inFlight || !this.pending.length || this.state.save === 'conflict') return;
    this.inFlight = true;
    const ops = this.pending.splice(0);
    try {
      const res = await this.send(`${this.endpoint}/ops`, { ops, revision: this.state.revision });
      this.state = { ...this.state, revision: res.draft.revision };
      this.inFlight = false;
      if (this.pending.length) return this.flush();
      this.set({ save: 'saved', error: undefined });
    } catch (err) {
      this.inFlight = false;
      if (err instanceof ApiError && err.status === 409) {
        this.set({ save: 'conflict', error: err.message });
      } else {
        this.pending.unshift(...ops);
        this.set({ save: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Resolves when all queued ops are saved (or saving failed). */
  async settled(): Promise<void> {
    for (let i = 0; i < 200 && (this.inFlight || this.pending.length) && this.state.save === 'saving'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

export function useEditor(store: EditorStore): EditorSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
