/** Dot paths such as `form.email` or `items.0.done`. */

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

export function splitPath(path: string): string[] {
  if (!path) return [];
  const segments = path.split('.');
  for (const s of segments) {
    if (!s || BLOCKED.has(s)) throw new Error(`Invalid path "${path}"`);
  }
  return segments;
}

export function getIn(obj: unknown, segments: readonly string[]): unknown {
  let cur = obj;
  for (const s of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Object.hasOwn(cur, s) ? (cur as Record<string, unknown>)[s] : undefined;
  }
  return cur;
}

/** Returns a copy of `obj` with `value` at `segments`, copying only along the path. */
export function setIn(obj: unknown, segments: readonly string[], value: unknown): unknown {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments as [string, ...string[]];
  const index = /^\d+$/.test(head) ? Number(head) : null;
  if (Array.isArray(obj) && index !== null) {
    const copy = obj.slice();
    copy[index] = setIn(obj[index], rest, value);
    return copy;
  }
  const base =
    obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  return { ...base, [head]: setIn(base[head], rest, value) };
}

/** Returns a copy of `obj` without the key at `segments`. */
export function unsetIn(obj: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0 || obj === null || typeof obj !== 'object') return obj;
  const [head, ...rest] = segments as [string, ...string[]];
  if (Array.isArray(obj)) {
    const i = Number(head);
    if (!Number.isInteger(i)) return obj;
    const copy = obj.slice();
    if (rest.length === 0) copy.splice(i, 1);
    else copy[i] = unsetIn(copy[i], rest);
    return copy;
  }
  const record = obj as Record<string, unknown>;
  if (!Object.hasOwn(record, head)) return obj;
  if (rest.length === 0) {
    const { [head]: _removed, ...others } = record;
    return others;
  }
  return { ...record, [head]: unsetIn(record[head], rest) };
}

/** Whether a change at `changed` can affect a reader of `dep` (one is a prefix of the other). */
export function pathsOverlap(changed: string, dep: string): boolean {
  return changed === dep || dep.startsWith(`${changed}.`) || changed.startsWith(`${dep}.`);
}
