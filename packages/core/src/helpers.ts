/** Built-in expression helpers. Hosts can add their own (e.g. `t` for i18n). */

export type Helper = (...args: any[]) => unknown;
export type HelperTree = { [name: string]: Helper | HelperTree };

function len(value: unknown): number {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function includes(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === 'string') return typeof needle === 'string' && haystack.includes(needle);
  if (Array.isArray(haystack)) return haystack.includes(needle);
  return false;
}

function round(n: unknown, digits: unknown = 0): number {
  const f = 10 ** Number(digits || 0);
  return Math.round(Number(n) * f) / f;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const DATE_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
  short: { dateStyle: 'short' },
  medium: { dateStyle: 'medium' },
  long: { dateStyle: 'long' },
  time: { timeStyle: 'short' },
  datetime: { dateStyle: 'medium', timeStyle: 'short' },
};

/** Marks a helper as reading ambient state, so expressions calling it re-render when that changes. */
function withDeps<F extends Helper>(deps: readonly string[], fn: F): F {
  return Object.assign(fn, { deps });
}

function withDepsTree(deps: readonly string[], tree: Record<string, Helper>): Record<string, Helper> {
  for (const fn of Object.values(tree)) withDeps(deps, fn);
  return tree;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const field = (item: unknown, key: unknown) =>
  item && typeof item === 'object' && typeof key === 'string' && Object.hasOwn(item, key)
    ? (item as Record<string, unknown>)[key]
    : undefined;

export function createBuiltinHelpers(
  getLocale: () => string | undefined,
  getTranslate?: () => ((key: string, vars?: Record<string, unknown>) => string) | undefined,
): HelperTree {
  const locale = () => getLocale() || undefined;
  return {
    /** Translate: `t('cart.items', { count: 3 })`. */
    t: withDeps(['i18n'], (key: unknown, vars?: unknown) => {
      const translate = getTranslate?.();
      const k = String(key ?? '');
      return translate
        ? translate(k, vars && typeof vars === 'object' ? (vars as Record<string, unknown>) : undefined)
        : k;
    }),
    len,
    // Lists (pagination, filtering, summaries) without lambdas.
    concat: (...lists: unknown[]) => lists.flatMap(asArray),
    merge: (...objects: unknown[]) =>
      Object.assign({}, ...objects.filter((o) => o && typeof o === 'object' && !Array.isArray(o))),
    pluck: (list: unknown, key: unknown) => asArray(list).map((item) => field(item, key)),
    find: (list: unknown, key: unknown, value: unknown) =>
      asArray(list).find((item) => field(item, key) === value) ?? null,
    filterBy: (list: unknown, key: unknown, value: unknown) =>
      asArray(list).filter((item) => field(item, key) === value),
    sortBy: (list: unknown, key: unknown, order: unknown = 'asc') => {
      const dir = order === 'desc' ? -1 : 1;
      return [...asArray(list)].sort((a, b) => {
        const x = field(a, key) as any;
        const y = field(b, key) as any;
        return x === y ? 0 : x > y ? dir : -dir;
      });
    },
    sum: (list: unknown, key?: unknown) =>
      asArray(list).reduce<number>(
        (acc, item) => acc + Number(key === undefined ? item : field(item, key)) || acc,
        0,
      ),
    unique: (list: unknown) => [...new Set(asArray(list))],
    includes,
    upper: (s: unknown) => (typeof s === 'string' ? s.toUpperCase() : s),
    lower: (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : s),
    trim: (s: unknown) => (typeof s === 'string' ? s.trim() : s),
    join: (a: unknown, sep: unknown = ', ') => (Array.isArray(a) ? a.join(String(sep)) : ''),
    slice: (a: unknown, start?: number, end?: number) =>
      typeof a === 'string' || Array.isArray(a) ? a.slice(start, end) : a,
    keys: (o: unknown) => (o && typeof o === 'object' ? Object.keys(o) : []),
    coalesce: (...args: unknown[]) => args.find((a) => a !== null && a !== undefined) ?? null,
    min: (...args: unknown[]) => Math.min(...args.map(Number)),
    max: (...args: unknown[]) => Math.max(...args.map(Number)),
    round,
    floor: (n: unknown) => Math.floor(Number(n)),
    ceil: (n: unknown) => Math.ceil(Number(n)),
    abs: (n: unknown) => Math.abs(Number(n)),
    number: (v: unknown) => Number(v),
    string: (v: unknown) => (v === null || v === undefined ? '' : String(v)),
    json: (v: unknown) => JSON.stringify(v),
    semver: (version: unknown, range: unknown) => satisfies(String(version ?? ''), String(range ?? '')),
    format: withDepsTree(['i18n.locale', 'device.locale'], {
      number: (n: unknown, maxDigits: unknown = 2) =>
        typeof n === 'number'
          ? new Intl.NumberFormat(locale(), { maximumFractionDigits: Number(maxDigits) }).format(n)
          : '',
      currency: (n: unknown, currency: unknown = 'USD') =>
        typeof n === 'number'
          ? new Intl.NumberFormat(locale(), {
              style: 'currency',
              currency: String(currency || 'USD'),
            }).format(n)
          : '',
      percent: (n: unknown) =>
        typeof n === 'number' ? new Intl.NumberFormat(locale(), { style: 'percent' }).format(n) : '',
      date: (value: unknown, style: unknown = 'medium') => {
        const d = toDate(value);
        return d
          ? new Intl.DateTimeFormat(locale(), DATE_STYLES[String(style)] ?? DATE_STYLES.medium).format(d)
          : '';
      },
    }),
  };
}

/** Collects every function in a helper tree, so the evaluator can allow exactly these. */
export function helperFunctions(tree: HelperTree, out = new WeakSet<object>()): WeakSet<object> {
  for (const value of Object.values(tree)) {
    if (typeof value === 'function') out.add(value);
    else if (value && typeof value === 'object') helperFunctions(value, out);
  }
  return out;
}

/** Dotted names of every helper (e.g. `format.currency`), for validation and editor autocomplete. */
export function helperNames(tree: HelperTree, prefix = ''): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'function') names.push(name);
    else names.push(...helperNames(value, name));
  }
  return names;
}

export const BUILTIN_HELPER_NAMES: readonly string[] = helperNames(createBuiltinHelpers(() => undefined));

// --- semver ------------------------------------------------------------------------------------

function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Checks a version against a range made of space-separated comparators
 * (`>=3.4 <4`, `=1.2.3`, `1.2.3`, `^3.4`, `~3.4.1`, `*`). Every comparator must hold.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const comparators = range.trim().split(/\s+/).filter(Boolean);
  if (comparators.length === 0) return true;
  return comparators.every((c) => {
    if (c === '*' || c === 'x') return true;
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(c);
    if (!m) return false;
    const target = parseVersion(m[2]!);
    if (!target) return false;
    const cmp = compare(v, target);
    switch (m[1]) {
      case '>=':
        return cmp >= 0;
      case '<=':
        return cmp <= 0;
      case '>':
        return cmp > 0;
      case '<':
        return cmp < 0;
      case '^':
        return cmp >= 0 && v[0] === target[0] && (target[0] !== 0 || v[1] === target[1]);
      case '~':
        return cmp >= 0 && v[0] === target[0] && v[1] === target[1];
      default:
        return cmp === 0;
    }
  });
}
