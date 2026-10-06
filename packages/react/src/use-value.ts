import type { CompiledValue, Frame, ScreenRuntime } from '@wishyor/zyrox-core';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useScreenRuntime } from './context';

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b))
    return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as any)[k], (b as any)[k])) return false;
  return true;
}

/** Evaluates a compiled value and re-evaluates only when the store paths it read change. */
class Binding {
  private value: unknown;
  private dirty = true;
  private deps = new Set<string>();

  constructor(
    private readonly runtime: ScreenRuntime,
    private readonly cv: CompiledValue,
    private readonly frame: Frame | null,
    private readonly nodeId?: string,
  ) {}

  get = (): unknown => {
    if (this.dirty) {
      const deps = new Set<string>();
      const next = this.runtime.evaluate(this.cv, this.frame, (p) => deps.add(p), this.nodeId);
      this.deps = deps;
      this.dirty = false;
      if (!shallowEqual(this.value, next)) this.value = next;
    }
    return this.value;
  };

  subscribe = (onChange: () => void): (() => void) =>
    this.runtime.store.watch(
      () => this.deps,
      () => {
        this.dirty = true;
        onChange();
      },
    );
}

const noSubscribe = () => () => {};

export function useValue(cv: CompiledValue | undefined, frame: Frame | null, nodeId?: string): unknown {
  const runtime = useScreenRuntime();
  const binding = useMemo(
    () => (cv && cv.k !== 's' ? new Binding(runtime, cv, frame, nodeId) : null),
    [runtime, cv, frame, nodeId],
  );
  const staticValue = cv?.k === 's' ? cv.v : undefined;
  const getStatic = useCallback(() => staticValue, [staticValue]);
  return useSyncExternalStore(
    binding?.subscribe ?? noSubscribe,
    binding?.get ?? getStatic,
    binding?.get ?? getStatic,
  );
}

/** Reads (and writes) a path in the current screen's state from inside your own components. */
export function useScreenState<T = unknown>(path: string): [T, (value: T) => void] {
  const runtime = useScreenRuntime();
  const full = `state.${path}`;
  const subscribe = useCallback((cb: () => void) => runtime.store.watch(() => [full], cb), [runtime, full]);
  const get = useCallback(() => runtime.store.get(full) as T, [runtime, full]);
  const value = useSyncExternalStore(subscribe, get, get);
  const set = useCallback((v: T) => runtime.setState(path, v), [runtime, path]);
  return [value, set];
}
