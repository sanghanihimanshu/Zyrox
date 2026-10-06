import type { Action, DataSource, Document, Motion, Node, RefreshTrigger, Value } from '@zyrox/protocol';
import {
  type Ast,
  type EvalEnv,
  ExprError,
  evaluate,
  hasTemplate,
  parseExpression,
  splitTemplate,
  stringify,
} from './expr';

/** A value with its expressions pre-parsed. Static values are kept as-is. */
export type CompiledValue =
  | { k: 's'; v: unknown }
  | { k: 'e'; ast: Ast; src: string }
  | { k: 't'; parts: (string | { ast: Ast; src: string })[] }
  | { k: 'a'; items: CompiledValue[] }
  | { k: 'o'; entries: [string, CompiledValue][] }
  | { k: 'x'; error: string; src: string };

export interface CompileProblem {
  message: string;
  nodeId?: string;
  source?: string;
}

export function compileValue(value: unknown, problems?: CompileProblem[], nodeId?: string): CompiledValue {
  if (typeof value === 'string') {
    if (!hasTemplate(value)) return { k: 's', v: value };
    try {
      const parts = splitTemplate(value);
      if (parts.length === 1 && typeof parts[0] === 'object') {
        const src = parts[0].src;
        return { k: 'e', ast: parseExpression(src), src };
      }
      if (parts.every((p) => typeof p === 'string')) return { k: 's', v: parts.join('') };
      return {
        k: 't',
        parts: parts.map((p) => (typeof p === 'string' ? p : { ast: parseExpression(p.src), src: p.src })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems?.push({ message: `Expression error: ${message}`, nodeId, source: value });
      return { k: 'x', error: message, src: value };
    }
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => compileValue(v, problems, nodeId));
    return items.every((i) => i.k === 's') ? { k: 's', v: value } : { k: 'a', items };
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([key, v]) => [key, compileValue(v, problems, nodeId)] as [string, CompiledValue],
    );
    return entries.every(([, v]) => v.k === 's') ? { k: 's', v: value } : { k: 'o', entries };
  }
  return { k: 's', v: value };
}

export type EvalErrorHandler = (error: unknown, source: string) => void;

export function evalValue(cv: CompiledValue, env: EvalEnv, onError?: EvalErrorHandler): unknown {
  switch (cv.k) {
    case 's':
      return cv.v;
    case 'e':
      try {
        return evaluate(cv.ast, env);
      } catch (err) {
        onError?.(err, cv.src);
        return undefined;
      }
    case 't': {
      let out = '';
      for (const part of cv.parts) {
        if (typeof part === 'string') {
          out += part;
          continue;
        }
        try {
          out += stringify(evaluate(part.ast, env));
        } catch (err) {
          onError?.(err, part.src);
        }
      }
      return out;
    }
    case 'a':
      return cv.items.map((item) => evalValue(item, env, onError));
    case 'o': {
      const out: Record<string, unknown> = {};
      for (const [key, v] of cv.entries) out[key] = evalValue(v, env, onError);
      return out;
    }
    case 'x':
      onError?.(new ExprError(cv.error), cv.src);
      return undefined;
  }
}

export interface CompiledAction {
  do: string;
  /** Every field except `do` and nested action lists. */
  args: CompiledValue;
  then?: CompiledAction[];
  else?: CompiledAction[];
  onSuccess?: CompiledAction[];
  onError?: CompiledAction[];
  onClose?: CompiledAction[];
  /** Action lists of buttons, by path: `buttons.0` (alert), `content.buttons.1` (sheet), `action` (toast). */
  nested?: Record<string, CompiledAction[]>;
  /** Arguments passed through unevaluated (an inline sheet `document` has its own scope). */
  literal?: Record<string, unknown>;
  source: Action;
}

export interface CompiledRepeat {
  each: CompiledValue;
  as: string;
  index: string;
  key?: CompiledValue;
}

export interface CompiledNode {
  id: string;
  type: string;
  source: Node;
  props: CompiledValue;
  children: CompiledNode[];
  slots: Record<string, CompiledNode[]>;
  templates: Record<string, CompiledNode>;
  on: Record<string, CompiledAction[]>;
  bind?: string;
  if?: CompiledValue;
  repeat?: CompiledRepeat;
  with?: [string, CompiledValue][];
  fallback?: CompiledNode;
  a11y?: CompiledValue;
  motion?: Motion;
  meta?: Record<string, Value>;
}

export interface CompiledField {
  /** Path relative to the form, e.g. `email` or `address.city`. */
  path: string;
  when?: CompiledValue;
  /** The rules object (minus `if`); evaluated with `value` in scope. */
  rules: CompiledValue;
  /** Required without conditions, for UI hints (asterisks). */
  required: boolean;
}

export interface CompiledForm {
  name: string;
  show: 'touched' | 'submit';
  fields: CompiledField[];
}

export interface CompiledDataSource {
  key: string;
  kind?: string;
  when?: CompiledValue;
  /** `{ url, method, headers, body }` */
  request: CompiledValue;
  refresh: RefreshTrigger[];
  debounce: number;
  /** Seconds a cached response stays fresh; 0 disables the cache. */
  cache: number;
  mock?: Value;
}

export interface CompiledDocument {
  source: Document;
  key: string;
  root: CompiledNode;
  nodes: Map<string, CompiledNode>;
  data: CompiledDataSource[];
  forms: CompiledForm[];
  problems: CompileProblem[];
}

const ACTION_LISTS = ['then', 'else', 'onSuccess', 'onError', 'onClose'] as const;
/** Built-ins whose buttons carry their own action lists. */
const WITH_BUTTONS = new Set(['alert', 'sheet', 'toast']);

/**
 * Pre-parses actions. With `literal`, strings are never treated as expressions: for actions sent
 * by a backend, whose text may contain user content.
 */
export function compileActions(
  actions: readonly Action[] | undefined,
  problems: CompileProblem[],
  nodeId?: string,
  literal = false,
): CompiledAction[] {
  return (actions ?? []).map((action) => {
    const {
      do: name,
      then,
      else: otherwise,
      onSuccess,
      onError,
      onClose,
      ...all
    } = action as Action & Record<string, unknown>;
    // A sheet's inline document is data with its own scope: never evaluated by the caller.
    const { document, ...rest } = name === 'sheet' ? all : { document: undefined, ...all };
    const lists = { then, else: otherwise, onSuccess, onError, onClose } as Record<
      string,
      Action[] | undefined
    >;
    const nested: Record<string, CompiledAction[]> = {};
    const args = WITH_BUTTONS.has(String(name))
      ? splitNested(rest, (path, list) => {
          nested[path] = compileActions(list, problems, nodeId, literal);
        })
      : rest;
    const compiled: CompiledAction = {
      do: String(name),
      args: literal ? { k: 's', v: args } : compileValue(args, problems, nodeId),
      source: action,
    };
    if (document !== undefined) compiled.literal = { document };
    if (Object.keys(nested).length) compiled.nested = nested;
    for (const list of ACTION_LISTS) {
      if (lists[list]) compiled[list] = compileActions(lists[list], problems, nodeId, literal);
    }
    return compiled;
  });
}

/** Whether an action's buttons carry their own action lists (`alert`, `sheet`, `toast`). */
export function hasButtonActions(name: string): boolean {
  return WITH_BUTTONS.has(name);
}

/**
 * Copies action args without the `actions` lists of their buttons, handing each list to `onList`
 * with its path (`buttons.0`, `content.buttons.1`, `action`).
 */
export function splitNested(
  value: Record<string, unknown>,
  onList: (path: string, list: Action[]) => void,
  path = '',
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (key === 'actions' && Array.isArray(v) && path) onList(path, v as Action[]);
    else if (Array.isArray(v))
      copy[key] = v.map((item, i) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? splitNested(item as Record<string, unknown>, onList, `${at}.${i}`)
          : item,
      );
    else if (v && typeof v === 'object') copy[key] = splitNested(v as Record<string, unknown>, onList, at);
    else copy[key] = v;
  }
  return copy;
}

function compileNode(node: Node, nodes: Map<string, CompiledNode>, problems: CompileProblem[]): CompiledNode {
  const p = (v: unknown) => compileValue(v, problems, node.id);
  if (nodes.has(node.id)) problems.push({ message: `Duplicate node id "${node.id}"`, nodeId: node.id });
  const compiled: CompiledNode = {
    id: node.id,
    type: node.type,
    source: node,
    props: node.props ? p(node.props) : { k: 's', v: {} },
    children: [],
    slots: {},
    templates: {},
    on: {},
  };
  nodes.set(node.id, compiled);
  compiled.children = (node.children ?? []).map((child) => compileNode(child, nodes, problems));
  for (const [name, list] of Object.entries(node.slots ?? {})) {
    compiled.slots[name] = list.map((child) => compileNode(child, nodes, problems));
  }
  for (const [name, template] of Object.entries(node.templates ?? {})) {
    compiled.templates[name] = compileNode(template, nodes, problems);
  }
  for (const [event, actions] of Object.entries(node.on ?? {})) {
    compiled.on[event] = compileActions(actions, problems, node.id);
  }
  if (node.bind) compiled.bind = node.bind;
  if (node.if !== undefined) compiled.if = p(node.if);
  if (node.repeat) {
    compiled.repeat = {
      each: p(node.repeat.each),
      as: node.repeat.as ?? 'item',
      index: node.repeat.index ?? 'index',
      key: node.repeat.key !== undefined ? p(node.repeat.key) : undefined,
    };
  }
  if (node.with) compiled.with = Object.entries(node.with).map(([name, v]) => [name, p(v)]);
  if (node.fallback) compiled.fallback = compileNode(node.fallback, nodes, problems);
  if (node.a11y) compiled.a11y = p(node.a11y);
  if (node.motion) compiled.motion = node.motion;
  if (node.meta) compiled.meta = node.meta;
  return compiled;
}

function compileDataSource(key: string, source: DataSource, problems: CompileProblem[]): CompiledDataSource {
  return {
    key,
    kind: source.kind,
    when: source.if !== undefined ? compileValue(source.if, problems) : undefined,
    request: compileValue(
      {
        url: source.url,
        method: source.method ?? 'GET',
        headers: source.headers ?? null,
        body: source.body ?? null,
      },
      problems,
    ),
    refresh: source.refresh ?? ['mount'],
    debounce: source.debounce ?? 0,
    cache: source.cache ?? 0,
    mock: source.mock,
  };
}

const cache = new WeakMap<Document, CompiledDocument>();

/**
 * Pre-parses every expression in a document and indexes its nodes. Never throws for bad
 * expressions: they are reported in `problems` and evaluate to `undefined`.
 */
export function compileDocument(doc: Document): CompiledDocument {
  const cached = cache.get(doc);
  if (cached) return cached;
  const problems: CompileProblem[] = [];
  const nodes = new Map<string, CompiledNode>();
  const root = compileNode(doc.root, nodes, problems);
  const data = Object.entries(doc.data ?? {}).map(([key, source]) =>
    compileDataSource(key, source, problems),
  );
  const forms = Object.entries(doc.forms ?? {}).map(
    ([name, form]): CompiledForm => ({
      name,
      show: form.show ?? 'touched',
      fields: Object.entries(form.fields).map(([path, { if: when, ...rules }]) => ({
        path,
        when: when === undefined ? undefined : compileValue(when, problems),
        rules: compileValue(rules as Value, problems),
        required:
          when === undefined &&
          (rules.required === true || (typeof rules.required === 'string' && !rules.required.includes('{{'))),
      })),
    }),
  );
  const compiled: CompiledDocument = { source: doc, key: doc.key, root, nodes, data, forms, problems };
  cache.set(doc, compiled);
  return compiled;
}
