import { Validator } from '@cfworker/json-schema';
import {
  type Action,
  BUILTIN_ACTIONS,
  type Document,
  documentSchema,
  type JsonSchema,
  LIFECYCLE_EVENTS,
  type Manifest,
  type Node,
} from '@wishyor/zyrox-protocol';
import { hasButtonActions, splitNested } from './compile';
import { type Ast, ExprError, hasTemplate, parseExpression, splitTemplate } from './expr';
import { BUILTIN_HELPER_NAMES } from './helpers';
import { STORE_ROOTS } from './runtime';

export type ProblemCode =
  | 'schema'
  | 'duplicate_id'
  | 'expression'
  | 'unknown_identifier'
  | 'unknown_reference'
  | 'unknown_helper'
  | 'unknown_component'
  | 'missing_prop'
  | 'invalid_prop'
  | 'unknown_prop'
  | 'unknown_event'
  | 'unknown_slot'
  | 'unknown_template'
  | 'children_not_allowed'
  | 'not_bindable'
  | 'unknown_action'
  | 'invalid_action_args'
  | 'unknown_motion'
  | 'unknown_transition'
  | 'unknown_form'
  | 'invalid_rule';

export interface Problem {
  level: 'error' | 'warning';
  code: ProblemCode;
  message: string;
  nodeId?: string;
  /** Dot path inside the document, e.g. `root.children.2.props.label`. */
  path?: string;
}

export interface ValidateOptions {
  /** The app build's manifest. Without it only structure and expressions are checked. */
  manifest?: Manifest;
  /** Extra helper names the host registers (in addition to the manifest's). */
  helpers?: readonly string[];
  /** Extra root identifiers that are defined (e.g. `input` inside block documents). */
  globals?: readonly string[];
}

const BUILTIN_ACTION_SET: ReadonlySet<string> = new Set(BUILTIN_ACTIONS);
const LIFECYCLE_SET: ReadonlySet<string> = new Set(LIFECYCLE_EVENTS);
const validatorCache = new WeakMap<object, Validator>();

function validatorFor(schema: JsonSchema): Validator {
  let v = validatorCache.get(schema);
  if (!v) {
    v = new Validator(schema as any, '2020-12', false);
    validatorCache.set(schema, v);
  }
  return v;
}

function containsTemplate(value: unknown): boolean {
  if (typeof value === 'string') return hasTemplate(value);
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (value && typeof value === 'object') return Object.values(value).some(containsTemplate);
  return false;
}

/** `a.b.c` member chains with static keys, rooted at an identifier. */
function staticPaths(ast: Ast, out: string[][] = []): string[][] {
  const chain = (node: Ast): string[] | null => {
    if (node.t === 'id') return [node.name];
    if (node.t === 'mem') {
      const base = chain(node.obj);
      const prop = node.prop;
      if (base && prop.t === 'lit' && (typeof prop.v === 'string' || typeof prop.v === 'number'))
        return [...base, String(prop.v)];
      return base;
    }
    return null;
  };
  const visit = (node: Ast): void => {
    switch (node.t) {
      case 'id':
      case 'mem': {
        const c = chain(node);
        if (c) out.push(c);
        if (node.t === 'mem') {
          visitInner(node.obj);
          if (node.computed) visit(node.prop);
        }
        return;
      }
      case 'call':
        visitInner(node.callee);
        node.args.forEach(visit);
        return;
      case 'un':
        visit(node.arg);
        return;
      case 'bin':
        visit(node.l);
        visit(node.r);
        return;
      case 'cond':
        visit(node.test);
        visit(node.then);
        visit(node.else);
        return;
      case 'arr':
        node.items.forEach(visit);
        return;
      case 'obj':
        for (const [, v] of node.entries) visit(v);
        return;
      case 'lit':
        return;
    }
  };
  // Inner parts of a member chain only matter for computed keys.
  const visitInner = (node: Ast): void => {
    if (node.t === 'mem') {
      visitInner(node.obj);
      if (node.computed) visit(node.prop);
    } else if (node.t !== 'id') {
      visit(node);
    }
  };
  visit(ast);
  return out;
}

function calledHelpers(ast: Ast, out: string[] = []): string[] {
  const name = (node: Ast): string | null => {
    if (node.t === 'id') return node.name;
    if (node.t === 'mem' && !node.computed && node.prop.t === 'lit') {
      const base = name(node.obj);
      return base ? `${base}.${String(node.prop.v)}` : null;
    }
    return null;
  };
  const visit = (node: Ast): void => {
    switch (node.t) {
      case 'call': {
        out.push(name(node.callee) ?? '(expression)');
        node.args.forEach(visit);
        return;
      }
      case 'mem':
        visit(node.obj);
        if (node.computed) visit(node.prop);
        return;
      case 'un':
        visit(node.arg);
        return;
      case 'bin':
        visit(node.l);
        visit(node.r);
        return;
      case 'cond':
        visit(node.test);
        visit(node.then);
        visit(node.else);
        return;
      case 'arr':
        node.items.forEach(visit);
        return;
      case 'obj':
        for (const [, v] of node.entries) visit(v);
        return;
      default:
        return;
    }
  };
  visit(ast);
  return out;
}

/**
 * Checks a document's structure, expressions and (with a manifest) every component, prop, event,
 * slot, binding, action and helper it uses. Never throws.
 */
export function validateDocument(input: unknown, options: ValidateOptions = {}): Problem[] {
  const problems: Problem[] = [];
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push({ level: 'error', code: 'schema', message: issue.message, path: issue.path.join('.') });
    }
    return problems;
  }
  const doc: Document = parsed.data;
  const manifest = options.manifest;
  const helperSet = new Set([
    ...BUILTIN_HELPER_NAMES,
    ...(manifest?.helpers ?? []),
    ...(options.helpers ?? []),
  ]);
  const helperRoots = new Set([...helperSet].map((h) => h.split('.')[0]!));
  const dataKeys = new Set(Object.keys(doc.data ?? {}));
  const formNames = new Set(Object.keys(doc.forms ?? {}));
  const paramKeys = doc.params ? new Set(Object.keys(doc.params)) : null;
  const ids = new Map<string, string>();

  const add = (p: Problem) => problems.push(p);

  const checkExpressions = (
    value: unknown,
    path: string,
    scope: ReadonlySet<string>,
    nodeId?: string,
  ): void => {
    if (typeof value === 'string') {
      if (!hasTemplate(value)) return;
      let parts: ReturnType<typeof splitTemplate>;
      try {
        parts = splitTemplate(value);
      } catch (err) {
        add({ level: 'error', code: 'expression', message: (err as Error).message, nodeId, path });
        return;
      }
      for (const part of parts) {
        if (typeof part === 'string') continue;
        let ast: Ast;
        try {
          ast = parseExpression(part.src);
        } catch (err) {
          const message = err instanceof ExprError ? err.message : String(err);
          add({
            level: 'error',
            code: 'expression',
            message: `${message} in "{{ ${part.src} }}"`,
            nodeId,
            path,
          });
          continue;
        }
        for (const helper of calledHelpers(ast)) {
          if (!helperSet.has(helper)) {
            add({
              level: manifest ? 'error' : 'warning',
              code: 'unknown_helper',
              message: `Unknown helper "${helper}"`,
              nodeId,
              path,
            });
          }
        }
        for (const chain of staticPaths(ast)) {
          const [root, key] = chain as [string, string | undefined];
          if (scope.has(root)) continue;
          if (!(STORE_ROOTS as readonly string[]).includes(root) && !helperRoots.has(root)) {
            add({
              level: 'warning',
              code: 'unknown_identifier',
              message: `"${root}" is not defined here`,
              nodeId,
              path,
            });
            continue;
          }
          if (key && (root === 'data' || root === 'loading' || root === 'error') && !dataKeys.has(key)) {
            add({
              level: 'warning',
              code: 'unknown_reference',
              message: `No data source "${key}"`,
              nodeId,
              path,
            });
          }
          if (key && root === 'params' && paramKeys && !paramKeys.has(key)) {
            add({ level: 'warning', code: 'unknown_reference', message: `No param "${key}"`, nodeId, path });
          }
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) checkExpressions(v, `${path}.${i}`, scope, nodeId);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) checkExpressions(v, `${path}.${k}`, scope, nodeId);
    }
  };

  const checkProps = (
    values: Record<string, unknown>,
    schema: JsonSchema,
    path: string,
    nodeId: string | undefined,
    kind: { missing: ProblemCode; invalid: ProblemCode; unknown?: ProblemCode },
    skipRequired: ReadonlySet<string> = new Set(),
  ) => {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const name of (schema.required ?? []) as string[]) {
      if (skipRequired.has(name)) continue;
      if (values[name] === undefined)
        add({ level: 'error', code: kind.missing, message: `Missing "${name}"`, nodeId, path });
    }
    for (const [name, value] of Object.entries(values)) {
      const propSchema = properties[name];
      if (!propSchema) {
        if (kind.unknown)
          add({
            level: 'warning',
            code: kind.unknown,
            message: `"${name}" is not declared and will be ignored`,
            nodeId,
            path: `${path}.${name}`,
          });
        continue;
      }
      if (containsTemplate(value) || value === null) continue;
      const result = validatorFor(propSchema).validate(value);
      if (!result.valid) {
        const detail =
          result.errors.find((e) => e.keyword !== 'properties')?.error ??
          result.errors[0]?.error ??
          'invalid';
        add({
          level: 'error',
          code: kind.invalid,
          message: `"${name}": ${detail}`,
          nodeId,
          path: `${path}.${name}`,
        });
      }
    }
  };

  const checkActions = (
    actions: readonly Action[] | undefined,
    path: string,
    scope: ReadonlySet<string>,
    nodeId: string,
  ) => {
    const actionScope = new Set([...scope, 'event']);
    (actions ?? []).forEach((action, i) => {
      const at = `${path}.${i}`;
      const {
        do: name,
        then,
        else: otherwise,
        onSuccess,
        onError,
        onClose,
        ...all
      } = action as Action & Record<string, any>;
      const buttonLists: [string, Action[]][] = [];
      // A sheet's inline document is checked on its own, with its own scope.
      const { document: inline, ...rest } = name === 'sheet' ? all : { document: undefined, ...all };
      const args = hasButtonActions(name)
        ? splitNested(rest, (p, list) => buttonLists.push([p, list]))
        : rest;
      checkExpressions(args, at, actionScope, nodeId);
      if (inline !== undefined) {
        for (const problem of validateDocument(inline, options))
          add({ ...problem, nodeId, path: `${at}.document${problem.path ? `.${problem.path}` : ''}` });
      }
      for (const [p, list] of buttonLists) checkActions(list, `${at}.${p}.actions`, actionScope, nodeId);
      if (!BUILTIN_ACTION_SET.has(name) && manifest) {
        const def = manifest.actions[name];
        if (!def)
          add({
            level: 'error',
            code: 'unknown_action',
            message: `Unknown action "${name}"`,
            nodeId,
            path: at,
          });
        else
          checkProps(args, def.args, at, nodeId, {
            missing: 'invalid_action_args',
            invalid: 'invalid_action_args',
            unknown: 'invalid_action_args',
          });
      }
      if (
        name === 'navigate' &&
        manifest?.transitions.length &&
        typeof args.transition === 'string' &&
        !containsTemplate(args.transition)
      ) {
        if (!manifest.transitions.includes(args.transition)) {
          add({
            level: 'warning',
            code: 'unknown_transition',
            message: `Unknown transition "${args.transition}"`,
            nodeId,
            path: at,
          });
        }
      }
      if (
        (name === 'validate' || name === 'resetForm' || name === 'setErrors') &&
        typeof args.form === 'string' &&
        !formNames.has(args.form)
      ) {
        add({ level: 'error', code: 'unknown_form', message: `No form "${args.form}"`, nodeId, path: at });
      }
      if (name === 'refresh' && typeof args.data === 'string' && !dataKeys.has(args.data)) {
        add({
          level: 'error',
          code: 'unknown_reference',
          message: `No data source "${args.data}"`,
          nodeId,
          path: at,
        });
      }
      checkActions(then, `${at}.then`, actionScope, nodeId);
      checkActions(otherwise, `${at}.else`, actionScope, nodeId);
      checkActions(onSuccess, `${at}.onSuccess`, actionScope, nodeId);
      checkActions(onError, `${at}.onError`, actionScope, nodeId);
      checkActions(onClose, `${at}.onClose`, actionScope, nodeId);
    });
  };

  const checkMotion = (node: Node, path: string) => {
    if (!node.motion || !manifest?.motions.length) return;
    for (const preset of [
      node.motion.enter,
      node.motion.exit,
      typeof node.motion.layout === 'string' ? node.motion.layout : undefined,
    ]) {
      if (preset && !manifest.motions.includes(preset)) {
        add({
          level: 'warning',
          code: 'unknown_motion',
          message: `Unknown motion preset "${preset}"`,
          nodeId: node.id,
          path: `${path}.motion`,
        });
      }
    }
  };

  const visit = (node: Node, path: string, outer: ReadonlySet<string>, hasFallback = false) => {
    const previous = ids.get(node.id);
    if (previous)
      add({
        level: 'error',
        code: 'duplicate_id',
        message: `Duplicate id "${node.id}" (also at ${previous})`,
        nodeId: node.id,
        path,
      });
    else ids.set(node.id, path);

    const scope = new Set(outer);
    if (node.repeat) {
      checkExpressions(node.repeat.each, `${path}.repeat.each`, outer, node.id);
      scope.add(node.repeat.as ?? 'item');
      scope.add(node.repeat.index ?? 'index');
      if (node.repeat.key !== undefined)
        checkExpressions(node.repeat.key, `${path}.repeat.key`, scope, node.id);
    }
    if (node.if !== undefined) checkExpressions(node.if, `${path}.if`, scope, node.id);
    if (node.with) {
      for (const [name, value] of Object.entries(node.with))
        checkExpressions(value, `${path}.with.${name}`, scope, node.id);
      for (const name of Object.keys(node.with)) scope.add(name);
    }
    checkExpressions(node.props ?? {}, `${path}.props`, scope, node.id);
    if (node.a11y) checkExpressions(node.a11y, `${path}.a11y`, scope, node.id);
    for (const [event, actions] of Object.entries(node.on ?? {}))
      checkActions(actions, `${path}.on.${event}`, scope, node.id);
    checkMotion(node, path);

    const def = manifest?.components[node.type];
    if (manifest && !def) {
      add({
        level: node.fallback || hasFallback ? 'warning' : 'error',
        code: 'unknown_component',
        message: node.fallback
          ? `Component "${node.type}" isn't in this app build; its fallback will render`
          : `Component "${node.type}" isn't in this app build`,
        nodeId: node.id,
        path,
      });
    }
    if (def) {
      checkProps(
        node.props ?? {},
        def.props,
        `${path}.props`,
        node.id,
        { missing: 'missing_prop', invalid: 'invalid_prop', unknown: 'unknown_prop' },
        new Set(def.bind ? [def.bind.prop] : []),
      );
      for (const event of Object.keys(node.on ?? {})) {
        if (!(event in def.events) && !LIFECYCLE_SET.has(event)) {
          add({
            level: 'warning',
            code: 'unknown_event',
            message: `"${node.type}" has no "${event}" event`,
            nodeId: node.id,
            path: `${path}.on.${event}`,
          });
        }
      }
      if (node.children?.length && !def.children) {
        add({
          level: 'warning',
          code: 'children_not_allowed',
          message: `"${node.type}" doesn't render children`,
          nodeId: node.id,
          path: `${path}.children`,
        });
      }
      for (const slot of Object.keys(node.slots ?? {})) {
        if (!def.slots.includes(slot))
          add({
            level: 'warning',
            code: 'unknown_slot',
            message: `"${node.type}" has no "${slot}" slot`,
            nodeId: node.id,
            path: `${path}.slots.${slot}`,
          });
      }
      for (const template of Object.keys(node.templates ?? {})) {
        if (!def.templates.includes(template))
          add({
            level: 'warning',
            code: 'unknown_template',
            message: `"${node.type}" has no "${template}" template`,
            nodeId: node.id,
            path: `${path}.templates.${template}`,
          });
      }
      if (node.bind && !def.bind)
        add({
          level: 'error',
          code: 'not_bindable',
          message: `"${node.type}" can't be bound`,
          nodeId: node.id,
          path: `${path}.bind`,
        });
    }

    for (const [i, child] of (node.children ?? []).entries()) visit(child, `${path}.children.${i}`, scope);
    for (const [name, list] of Object.entries(node.slots ?? {})) {
      for (const [i, child] of list.entries()) visit(child, `${path}.slots.${name}.${i}`, scope);
    }
    for (const [name, template] of Object.entries(node.templates ?? {})) {
      visit(template, `${path}.templates.${name}`, new Set([...scope, 'item', 'index']));
    }
    if (node.fallback) visit(node.fallback, `${path}.fallback`, scope, true);
  };

  for (const [key, source] of Object.entries(doc.data ?? {})) {
    const { mock: _mock, ...rest } = source;
    checkExpressions(rest, `data.${key}`, new Set(options.globals));
  }
  for (const [name, form] of Object.entries(doc.forms ?? {})) {
    const initial = doc.state?.[name];
    if (!initial || typeof initial !== 'object' || Array.isArray(initial))
      add({
        level: 'warning',
        code: 'invalid_rule',
        message: `Give form "${name}" initial values in state.${name}`,
        path: `forms.${name}`,
      });
    for (const [field, rules] of Object.entries(form.fields)) {
      const at = `forms.${name}.fields.${field}`;
      checkExpressions(rules, at, new Set([...(options.globals ?? []), 'value']));
      const pattern =
        rules.pattern && typeof rules.pattern === 'object'
          ? (rules.pattern as { value: unknown }).value
          : rules.pattern;
      if (typeof pattern === 'string' && !containsTemplate(pattern)) {
        try {
          new RegExp(pattern, 'u');
        } catch {
          add({
            level: 'error',
            code: 'invalid_rule',
            message: `"${field}": invalid pattern ${pattern}`,
            path: `${at}.pattern`,
          });
        }
      }
    }
  }
  visit(doc.root, 'root', new Set(options.globals));
  return problems;
}

export function hasErrors(problems: readonly Problem[]): boolean {
  return problems.some((p) => p.level === 'error');
}
