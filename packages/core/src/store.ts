import { getIn, pathsOverlap, setIn, splitPath } from './path';

export type StoreListener = (changedPath: string) => void;

/**
 * A tiny immutable store for a screen's `state`, `data`, `loading` and `error` roots.
 * Listeners receive the changed path and decide whether they care (see `pathsOverlap`).
 */
export class Store {
  private root: Record<string, unknown>;
  private readonly listeners = new Set<StoreListener>();

  constructor(initial: Record<string, unknown>) {
    this.root = initial;
  }

  snapshot(): Record<string, unknown> {
    return this.root;
  }

  get(path: string): unknown {
    return getIn(this.root, splitPath(path));
  }

  set(path: string, value: unknown): void {
    const segments = splitPath(path);
    if (getIn(this.root, segments) === value) return;
    this.root = setIn(this.root, segments, value) as Record<string, unknown>;
    for (const listener of [...this.listeners]) listener(path);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribes to changes that overlap any of `paths()` (re-read on every change). */
  watch(paths: () => Iterable<string>, onChange: () => void): () => void {
    return this.subscribe((changed) => {
      for (const dep of paths()) {
        if (pathsOverlap(changed, dep)) {
          onChange();
          return;
        }
      }
    });
  }
}
