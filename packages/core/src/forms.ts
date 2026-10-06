/**
 * Field validation for document forms. Rules arrive already evaluated (expressions resolved), so
 * this is plain, synchronous checking. Messages can be customised per rule, translated with
 * `zyrox.form.<rule>` keys, or fall back to English.
 */

export type Translate = (key: string, vars: Record<string, unknown>) => string | undefined;

const DEFAULT_MESSAGES: Record<string, string> = {
  required: 'This field is required',
  minLength: 'Enter at least {n} characters',
  maxLength: 'Enter at most {n} characters',
  min: 'Enter {n} or more',
  max: 'Enter {n} or less',
  number: 'Enter a number',
  pattern: 'Invalid format',
  email: 'Enter a valid email address',
  url: 'Enter a valid URL',
  oneOf: 'Choose one of the options',
  equals: "Values don't match",
  invalid: 'Invalid value',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
const MAX_INPUT = 10_000;
const patterns = new Map<string, RegExp | null>();

function regex(source: string): RegExp | null {
  let re = patterns.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source, 'u');
    } catch {
      re = null;
    }
    if (patterns.size > 500) patterns.clear();
    patterns.set(source, re);
  }
  return re;
}

/** Empty values fail `required`: undefined, null, false, blank strings and empty lists. */
export function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function param(rule: unknown): { value: unknown; message?: string } {
  if (rule && typeof rule === 'object' && !Array.isArray(rule) && 'value' in rule) {
    const r = rule as { value: unknown; message?: unknown };
    return { value: r.value, message: typeof r.message === 'string' && r.message ? r.message : undefined };
  }
  return { value: rule };
}

function message(
  rule: string,
  custom: string | undefined,
  vars: Record<string, unknown>,
  translate?: Translate,
): string {
  if (custom) return custom;
  const translated = translate?.(`zyrox.form.${rule}`, vars);
  if (translated) return translated;
  return (DEFAULT_MESSAGES[rule] ?? DEFAULT_MESSAGES.invalid!).replace('{n}', String(vars.n ?? ''));
}

const flagMessage = (rule: unknown) => (typeof rule === 'string' && rule ? rule : undefined);

/** The first failing rule's message for `value`, or `null` when valid. */
export function checkField(
  value: unknown,
  rules: Record<string, unknown>,
  translate?: Translate,
): string | null {
  const t = (rule: string, custom?: string, vars: Record<string, unknown> = {}) =>
    message(rule, custom, vars, translate);
  if (isEmptyValue(value)) {
    if (rules.required) return t('required', flagMessage(rules.required));
  } else {
    const text = typeof value === 'string' ? value.slice(0, MAX_INPUT) : value;
    const length = typeof text === 'string' || Array.isArray(text) ? text.length : undefined;
    for (const [rule, check] of [
      ['minLength', (n: number) => length === undefined || length >= n],
      ['maxLength', (n: number) => length === undefined || length <= n],
    ] as const) {
      if (rules[rule] === undefined || rules[rule] === null) continue;
      const p = param(rules[rule]);
      const n = Number(p.value);
      if (Number.isFinite(n) && !check(n)) return t(rule, p.message, { n });
    }
    for (const rule of ['min', 'max'] as const) {
      if (rules[rule] === undefined || rules[rule] === null) continue;
      const p = param(rules[rule]);
      const n = Number(p.value);
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(num)) return t('number');
      if (Number.isFinite(n) && (rule === 'min' ? num < n : num > n)) return t(rule, p.message, { n });
    }
    if (rules.pattern !== undefined && rules.pattern !== null) {
      const p = param(rules.pattern);
      const re = regex(String(p.value));
      if (re && !re.test(String(text))) return t('pattern', p.message);
    }
    if (rules.email && !EMAIL.test(String(text))) return t('email', flagMessage(rules.email));
    if (rules.url && !URL_PATTERN.test(String(text))) return t('url', flagMessage(rules.url));
    if (rules.oneOf !== undefined && rules.oneOf !== null) {
      const p = param(rules.oneOf);
      if (Array.isArray(p.value) && !p.value.includes(value)) return t('oneOf', p.message);
    }
    if (rules.equals !== undefined) {
      const p = param(rules.equals);
      if (value !== p.value) return t('equals', p.message);
    }
  }
  for (const custom of Array.isArray(rules.rules) ? rules.rules : []) {
    const c = custom as { check?: unknown; message?: unknown };
    if (!c.check) return typeof c.message === 'string' && c.message ? c.message : t('invalid');
  }
  return null;
}
