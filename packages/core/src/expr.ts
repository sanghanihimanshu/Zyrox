/**
 * The Zyrox expression language: a safe subset of JavaScript expressions.
 *
 * Supported: number/string/boolean/null literals, identifiers, member access (`a.b`, `a[b]`,
 * `a?.b`; always null-safe), calls to registered helpers, unary `! - +`, binary
 * `* / % + - < <= > >= == != === !==` (`==` is strict), `&& || ??`, ternary, array and
 * object literals. No assignment, no lambdas, no globals, no prototype access.
 */

export type Ast =
  | { t: 'lit'; v: unknown }
  | { t: 'id'; name: string }
  | { t: 'mem'; obj: Ast; prop: Ast; computed: boolean }
  | { t: 'call'; callee: Ast; args: Ast[] }
  | { t: 'un'; op: '!' | '-' | '+'; arg: Ast }
  | { t: 'bin'; op: string; l: Ast; r: Ast }
  | { t: 'cond'; test: Ast; then: Ast; else: Ast }
  | { t: 'arr'; items: Ast[] }
  | { t: 'obj'; entries: [string, Ast][] };

export class ExprError extends Error {
  constructor(
    message: string,
    readonly source?: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}

export const LIMITS = { sourceLength: 2000, nodes: 500, depth: 64 } as const;

type Token =
  | { k: 'num'; v: number; p: number }
  | { k: 'str'; v: string; p: number }
  | { k: 'id'; v: string; p: number }
  | { k: 'op'; v: string; p: number }
  | { k: 'eof'; v: ''; p: number };

const OPERATORS = [
  '===',
  '!==',
  '?.',
  '??',
  '&&',
  '||',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '?',
  ':',
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
];

const BINARY_PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '===': 4,
  '!==': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdPart = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      tokens.push({ k: 'num', v: Number(m[0]), p: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      let out = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          const n = src[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
          if (n === 'u') {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ExprError('Invalid unicode escape', src, i);
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            continue;
          }
          out += n !== undefined && n in map ? map[n] : (n ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (src[i] !== c) throw new ExprError('Unterminated string', src, start);
      i++;
      tokens.push({ k: 'str', v: out, p: start });
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      while (i < src.length && isIdPart(src[i]!)) i++;
      tokens.push({ k: 'id', v: src.slice(start, i), p: start });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unexpected character "${c}"`, src, i);
    // `a?.5:1` is a ternary, not optional chaining.
    if (op === '?.' && isDigit(src[i + 2] ?? '')) {
      tokens.push({ k: 'op', v: '?', p: i });
      i += 1;
      continue;
    }
    tokens.push({ k: 'op', v: op, p: i });
    i += op.length;
  }
  tokens.push({ k: 'eof', v: '', p: src.length });
  return tokens;
}

class Parser {
  private pos = 0;
  private nodes = 0;
  private depth = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.k === 'op' && t.v === v;
  }
  private expectOp(v: string): void {
    const t = this.next();
    if (t.k !== 'op' || t.v !== v) this.fail(`Expected "${v}"`, t);
  }
  private fail(message: string, t: Token = this.peek()): never {
    throw new ExprError(t.k === 'eof' ? `${message} but reached the end` : message, this.src, t.p);
  }
  private node<A extends Ast>(ast: A): A {
    if (++this.nodes > LIMITS.nodes) this.fail('Expression is too large');
    return ast;
  }
  private enter(): void {
    if (++this.depth > LIMITS.depth) this.fail('Expression is nested too deeply');
  }
  private leave(): void {
    this.depth--;
  }

  parse(): Ast {
    const ast = this.expression();
    if (this.peek().k !== 'eof') this.fail(`Unexpected "${this.peek().v}"`);
    return ast;
  }

  private expression(): Ast {
    this.enter();
    const test = this.binary(1);
    let result = test;
    if (this.isOp('?')) {
      this.next();
      const then = this.expression();
      this.expectOp(':');
      const otherwise = this.expression();
      result = this.node({ t: 'cond', test, then, else: otherwise });
    }
    this.leave();
    return result;
  }

  private binary(minPrec: number): Ast {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const prec = t.k === 'op' ? BINARY_PRECEDENCE[t.v] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      this.enter();
      const right = this.binary(prec + 1);
      this.leave();
      left = this.node({ t: 'bin', op: String(t.v), l: left, r: right });
    }
  }

  private unary(): Ast {
    const t = this.peek();
    if (t.k === 'op' && (t.v === '!' || t.v === '-' || t.v === '+')) {
      this.next();
      this.enter();
      const arg = this.unary();
      this.leave();
      return this.node({ t: 'un', op: t.v, arg });
    }
    return this.postfix(this.primary());
  }

  private postfix(start: Ast): Ast {
    let expr = start;
    for (;;) {
      if (this.isOp('.') || this.isOp('?.')) {
        this.next();
        const name = this.next();
        if (name.k !== 'id') this.fail('Expected a property name', name);
        expr = this.node({ t: 'mem', obj: expr, prop: { t: 'lit', v: name.v }, computed: false });
      } else if (this.isOp('[')) {
        this.next();
        const prop = this.expression();
        this.expectOp(']');
        expr = this.node({ t: 'mem', obj: expr, prop, computed: true });
      } else if (this.isOp('(')) {
        this.next();
        const args = this.list(')');
        expr = this.node({ t: 'call', callee: expr, args });
      } else {
        return expr;
      }
    }
  }

  private list(close: string): Ast[] {
    const items: Ast[] = [];
    while (!this.isOp(close)) {
      items.push(this.expression());
      if (!this.isOp(close)) this.expectOp(',');
    }
    this.next();
    return items;
  }

  private primary(): Ast {
    const t = this.next();
    switch (t.k) {
      case 'num':
      case 'str':
        return this.node({ t: 'lit', v: t.v });
      case 'id':
        if (t.v === 'true') return this.node({ t: 'lit', v: true });
        if (t.v === 'false') return this.node({ t: 'lit', v: false });
        if (t.v === 'null') return this.node({ t: 'lit', v: null });
        if (t.v === 'undefined') return this.node({ t: 'lit', v: undefined });
        return this.node({ t: 'id', name: t.v });
      case 'op':
        if (t.v === '(') {
          const inner = this.expression();
          this.expectOp(')');
          return inner;
        }
        if (t.v === '[') return this.node({ t: 'arr', items: this.list(']') });
        if (t.v === '{') return this.object();
        return this.fail(`Unexpected "${t.v}"`, t);
      default:
        return this.fail('Expected a value', t);
    }
  }

  private object(): Ast {
    const entries: [string, Ast][] = [];
    while (!this.isOp('}')) {
      const key = this.next();
      if (key.k !== 'id' && key.k !== 'str' && key.k !== 'num') this.fail('Expected a property name', key);
      const name = String(key.v);
      if (key.k === 'id' && !this.isOp(':')) {
        entries.push([name, { t: 'id', name }]);
      } else {
        this.expectOp(':');
        entries.push([name, this.expression()]);
      }
      if (!this.isOp('}')) this.expectOp(',');
    }
    this.next();
    return this.node({ t: 'obj', entries });
  }
}

const astCache = new Map<string, Ast>();

/** Parses one expression (without `{{ }}`). Results are cached. Throws `ExprError`. */
export function parseExpression(src: string): Ast {
  const cached = astCache.get(src);
  if (cached) return cached;
  if (src.length > LIMITS.sourceLength) throw new ExprError('Expression is too long', src, 0);
  const ast = new Parser(tokenize(src), src).parse();
  if (astCache.size > 5000) astCache.clear();
  astCache.set(src, ast);
  return ast;
}

// ---------------------------------------------------------------------------------------------
// Evaluation

export interface EvalEnv {
  /** Resolves a root identifier. Return `MISSING` when it isn't defined. */
  lookup(name: string): unknown;
  /** Called with the full dot path of every value read from a root identifier. */
  track?(path: string): void;
  /** Functions that expressions may call. Anything else is rejected. */
  isCallable(fn: unknown): boolean;
}

export const MISSING: unique symbol = Symbol('missing');

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Reads `key` from `obj` without reaching into prototypes. */
export function readKey(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof key !== 'string' && typeof key !== 'number') return undefined;
  const k = String(key);
  if (BLOCKED_KEYS.has(k)) return undefined;
  if (typeof obj === 'string') {
    if (k === 'length') return obj.length;
    return /^\d+$/.test(k) ? obj[Number(k)] : undefined;
  }
  if (Array.isArray(obj)) {
    if (k === 'length') return obj.length;
    return /^\d+$/.test(k) ? obj[Number(k)] : undefined;
  }
  if (typeof obj === 'object' || typeof obj === 'function') {
    return Object.hasOwn(obj as object, k) ? (obj as Record<string, unknown>)[k] : undefined;
  }
  return undefined;
}

interface Ref {
  value: unknown;
  path: string | null;
}

function evalRef(ast: Ast, env: EvalEnv): Ref {
  if (ast.t === 'id') {
    const value = env.lookup(ast.name);
    if (value === MISSING) return { value: undefined, path: null };
    return { value, path: ast.name };
  }
  if (ast.t === 'mem') {
    const obj = evalRef(ast.obj, env);
    const key = ast.computed ? evaluate(ast.prop, env) : (ast.prop as { v: unknown }).v;
    const value = readKey(obj.value, key);
    const path =
      obj.path !== null && (typeof key === 'string' || typeof key === 'number') ? `${obj.path}.${key}` : null;
    if (obj.path !== null && path === null) env.track?.(obj.path);
    return { value, path };
  }
  return { value: evaluate(ast, env), path: null };
}

function truthy(v: unknown): boolean {
  return Boolean(v);
}

export function evaluate(ast: Ast, env: EvalEnv): unknown {
  switch (ast.t) {
    case 'lit':
      return ast.v;
    case 'id':
    case 'mem': {
      const ref = evalRef(ast, env);
      if (ref.path !== null) env.track?.(ref.path);
      return ref.value;
    }
    case 'call': {
      const callee = evalRef(ast.callee, env).value;
      if (typeof callee !== 'function' || !env.isCallable(callee)) {
        throw new ExprError(`${describeCallee(ast.callee)} is not a helper`);
      }
      // Helpers that read ambient state (locale, translations) declare it, so callers re-render.
      const deps = (callee as { deps?: readonly string[] }).deps;
      if (deps) for (const dep of deps) env.track?.(dep);
      return (callee as (...a: unknown[]) => unknown)(...ast.args.map((a) => evaluate(a, env)));
    }
    case 'un': {
      const v = evaluate(ast.arg, env);
      if (ast.op === '!') return !truthy(v);
      if (ast.op === '-') return -(v as number);
      return +(v as number);
    }
    case 'bin': {
      if (ast.op === '&&') {
        const l = evaluate(ast.l, env);
        return truthy(l) ? evaluate(ast.r, env) : l;
      }
      if (ast.op === '||') {
        const l = evaluate(ast.l, env);
        return truthy(l) ? l : evaluate(ast.r, env);
      }
      if (ast.op === '??') {
        const l = evaluate(ast.l, env);
        return l === null || l === undefined ? evaluate(ast.r, env) : l;
      }
      const l = evaluate(ast.l, env) as any;
      const r = evaluate(ast.r, env) as any;
      switch (ast.op) {
        case '==':
        case '===':
          return l === r;
        case '!=':
        case '!==':
          return l !== r;
        case '<':
          return l < r;
        case '<=':
          return l <= r;
        case '>':
          return l > r;
        case '>=':
          return l >= r;
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return l / r;
        case '%':
          return l % r;
      }
      throw new ExprError(`Unknown operator ${ast.op}`);
    }
    case 'cond':
      return truthy(evaluate(ast.test, env)) ? evaluate(ast.then, env) : evaluate(ast.else, env);
    case 'arr':
      return ast.items.map((item) => evaluate(item, env));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of ast.entries) if (!BLOCKED_KEYS.has(k)) out[k] = evaluate(v, env);
      return out;
    }
  }
}

function describeCallee(ast: Ast): string {
  if (ast.t === 'id') return ast.name;
  if (ast.t === 'mem' && !ast.computed) return `${describeCallee(ast.obj)}.${(ast.prop as { v: string }).v}`;
  return 'expression';
}

/** Root identifiers and called helper names an expression refers to (for validation). */
export function collectRefs(
  ast: Ast,
  out: { ids: Set<string>; calls: Set<string> } = { ids: new Set(), calls: new Set() },
) {
  switch (ast.t) {
    case 'id':
      out.ids.add(ast.name);
      break;
    case 'mem':
      collectRefs(ast.obj, out);
      if (ast.computed) collectRefs(ast.prop, out);
      break;
    case 'call':
      out.calls.add(describeCallee(ast.callee));
      collectRefs(ast.callee, out);
      for (const a of ast.args) collectRefs(a, out);
      break;
    case 'un':
      collectRefs(ast.arg, out);
      break;
    case 'bin':
      collectRefs(ast.l, out);
      collectRefs(ast.r, out);
      break;
    case 'cond':
      collectRefs(ast.test, out);
      collectRefs(ast.then, out);
      collectRefs(ast.else, out);
      break;
    case 'arr':
      for (const a of ast.items) collectRefs(a, out);
      break;
    case 'obj':
      for (const [, v] of ast.entries) collectRefs(v, out);
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Templates: values that contain `{{ expression }}`

export type TemplatePart = string | { src: string };

/** Splits a string into literal text and `{{ }}` expression sources. `\{{` escapes a literal `{{`. */
export function splitTemplate(input: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = '';
  let i = 0;
  while (i < input.length) {
    if (input.startsWith('\\{{', i)) {
      text += '{{';
      i += 3;
      continue;
    }
    if (input.startsWith('{{', i)) {
      let j = i + 2;
      let quote: string | null = null;
      while (j < input.length) {
        const c = input[j]!;
        if (quote) {
          if (c === '\\') j++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (input.startsWith('}}', j)) {
          break;
        }
        j++;
      }
      if (j >= input.length) throw new ExprError('Missing "}}"', input, i);
      if (text) parts.push(text);
      text = '';
      parts.push({ src: input.slice(i + 2, j).trim() });
      i = j + 2;
      continue;
    }
    text += input[i];
    i++;
  }
  if (text) parts.push(text);
  return parts;
}

export function hasTemplate(value: string): boolean {
  return value.includes('{{');
}

/** Formats an interpolated value: `null`/`undefined` become empty, objects become JSON. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}
