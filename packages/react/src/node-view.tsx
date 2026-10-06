import {
  type CompiledNode,
  type CompiledValue,
  childFrame,
  type Frame,
  type ScreenRuntime,
} from '@wishyor/zyrox-core';
import { Component, createElement, type ReactNode, useEffect, useMemo } from 'react';
import { FrameContext, useFrame, useScreenRuntime, useZyrox } from './context';
import { getPlatform } from './platform-api';
import type { ImplementedComponent } from './registry';
import { useValue } from './use-value';

const TRUE: CompiledValue = { k: 's', v: true };
const EMPTY: CompiledValue = { k: 's', v: undefined };

function handlerName(event: string): string {
  return `on${event.charAt(0).toUpperCase()}${event.slice(1)}`;
}

function frameKey(item: unknown, index: number): string | number {
  if (item && typeof item === 'object') {
    const id = (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).key;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return index;
}

// --- Error isolation -----------------------------------------------------------------------------

interface BoundaryProps {
  node: CompiledNode;
  runtime: ScreenRuntime;
  children: ReactNode;
}

/** A render error in one node renders its `fallback` (or nothing); the rest of the screen survives. */
class NodeBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    const { node, runtime } = this.props;
    runtime.emit({
      type: 'error',
      kind: 'render',
      message: error instanceof Error ? error.message : String(error),
      nodeId: node.id,
      meta: node.meta,
      source: node.type,
    });
  }

  override componentDidUpdate(prev: BoundaryProps) {
    if (this.state.failed && prev.node !== this.props.node) this.setState({ failed: false });
  }

  override render() {
    if (this.state.failed)
      return this.props.node.fallback ? <NodeView node={this.props.node.fallback} /> : null;
    return this.props.children;
  }
}

// --- Rendering ------------------------------------------------------------------------------------

export function NodeList({ nodes }: { nodes: readonly CompiledNode[] | undefined }): ReactNode {
  if (!nodes?.length) return null;
  return nodes.map((node) => <NodeView key={node.id} node={node} />);
}

/** Renders one document node: repeat, if, with, motion, the component, its slots and events. */
export function NodeView({ node }: { node: CompiledNode }): ReactNode {
  const runtime = useScreenRuntime();
  const { inspect } = useZyrox();
  const content = (
    <NodeBoundary node={node} runtime={runtime}>
      {node.repeat ? <RepeatView node={node} /> : <ConditionalNode node={node} />}
    </NodeBoundary>
  );
  if (!inspect) return content;
  const { Inspect } = getPlatform();
  return <Inspect nodeId={node.id}>{content}</Inspect>;
}

function RepeatView({ node }: { node: CompiledNode }): ReactNode {
  const frame = useFrame();
  const runtime = useScreenRuntime();
  const { registry } = useZyrox();
  const repeat = node.repeat!;
  const items = useValue(repeat.each, frame, node.id);
  const list = Array.isArray(items) ? items : [];
  const children = list.map((item, index) => {
    const vars = { [repeat.as]: item, [repeat.index]: index };
    const key = repeat.key
      ? runtime.evaluate(repeat.key, childFrame(frame, vars), undefined, node.id)
      : frameKey(item, index);
    return <RepeatItem key={String(key ?? index)} node={node} frame={frame} vars={vars} />;
  });
  const Group = node.motion ? registry.motion?.Group : undefined;
  return Group ? <Group>{children}</Group> : children;
}

function RepeatItem({
  node,
  frame,
  vars,
}: {
  node: CompiledNode;
  frame: Frame | null;
  vars: Record<string, unknown>;
}) {
  const values = Object.values(vars);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the frame only changes when its values do
  const itemFrame = useMemo(() => childFrame(frame, vars), [frame, ...values]);
  return (
    <FrameContext.Provider value={itemFrame}>
      <ConditionalNode node={node} />
    </FrameContext.Provider>
  );
}

function ConditionalNode({ node }: { node: CompiledNode }): ReactNode {
  const frame = useFrame();
  const { registry } = useZyrox();
  const visible = Boolean(useValue(node.if ?? TRUE, frame, node.id));
  const Motion = node.motion ? registry.motion?.Item : undefined;
  if (Motion && node.motion) {
    return (
      <Motion motion={node.motion} visible={visible} nodeId={node.id}>
        {visible ? <ScopedNode node={node} /> : null}
      </Motion>
    );
  }
  return visible ? <ScopedNode node={node} /> : null;
}

function ScopedNode({ node }: { node: CompiledNode }): ReactNode {
  const frame = useFrame();
  const withValue = useMemo<CompiledValue>(
    () => (node.with ? { k: 'o', entries: node.with } : EMPTY),
    [node],
  );
  const vars = useValue(withValue, frame, node.id) as Record<string, unknown> | undefined;
  const scoped = useMemo(() => (vars ? childFrame(frame, vars) : frame), [frame, vars]);
  const { registry } = useZyrox();
  const impl = registry.components.get(node.type);
  const body = impl ? <ComponentNode node={node} impl={impl} /> : <MissingComponent node={node} />;
  return scoped === frame ? body : <FrameContext.Provider value={scoped}>{body}</FrameContext.Provider>;
}

function MissingComponent({ node }: { node: CompiledNode }): ReactNode {
  const runtime = useScreenRuntime();
  useEffect(() => {
    runtime.reportOnce(`unknown:${node.id}:${node.type}`, {
      type: 'error',
      kind: 'unknown_component',
      message: `No component "${node.type}" in this app build${node.fallback ? '; rendering fallback' : ''}`,
      nodeId: node.id,
      meta: node.meta,
      source: node.type,
    });
  }, [runtime, node]);
  return node.fallback ? <NodeView node={node.fallback} /> : null;
}

function TemplateItem({
  node,
  frame,
  item,
  index,
}: {
  node: CompiledNode;
  frame: Frame | null;
  item: unknown;
  index: number;
}) {
  const itemFrame = useMemo(() => childFrame(frame, { item, index }), [frame, item, index]);
  return (
    <FrameContext.Provider value={itemFrame}>
      <NodeView node={node} />
    </FrameContext.Provider>
  );
}

function ComponentNode({ node, impl }: { node: CompiledNode; impl: ImplementedComponent }): ReactNode {
  const frame = useFrame();
  const runtime = useScreenRuntime();
  const { debug } = useZyrox();
  const def = impl.def;
  const props = useValue(node.props, frame, node.id) as Record<string, unknown> | undefined;
  const a11y = useValue(node.a11y ?? EMPTY, frame, node.id) as Record<string, unknown> | undefined;
  const bindPath = node.bind && def.bind ? node.bind : undefined;
  const bound = useValue(bindPath ? bindExpression(bindPath) : EMPTY, frame, node.id);
  // A field of a document form: errors show on the component's `error` prop automatically.
  const field = useMemo(() => (bindPath ? runtime.formField(bindPath) : undefined), [runtime, bindPath]);
  const shape = (def.props as { shape?: Record<string, unknown> }).shape ?? {};
  const own = node.source.props ?? {};
  const autoError = Boolean(field && 'error' in shape && !('error' in own));
  const formError = useValue(
    autoError && field ? formErrorExpression(field.form, field.field) : EMPTY,
    frame,
    node.id,
  );

  const handlers = useMemo(() => {
    const out: Record<string, (payload?: unknown) => void> = {};
    // Fields count as touched when they lose focus, or on change if the component has no `blur`.
    const touchOnBlur = Boolean(field && 'blur' in def.events);
    for (const event of Object.keys(def.events)) {
      const actions = node.on[event];
      const isBind = bindPath && def.bind?.event === event;
      const touches = Boolean(field && bindPath && (touchOnBlur ? event === 'blur' : isBind));
      if (!actions?.length && !isBind && !touches) continue;
      out[handlerName(event)] = (payload?: unknown) => {
        if (isBind) runtime.setState(bindPath, payload);
        if (touches && bindPath) runtime.touch(bindPath);
        if (actions?.length) void runtime.run(actions, frame, payload, node.id);
      };
    }
    return out;
  }, [def, node, frame, runtime, bindPath, field]);

  const slots = useMemo(() => {
    const out: Record<string, ReactNode> = {};
    for (const name of def.slots)
      out[name] = node.slots[name]?.length ? <NodeList nodes={node.slots[name]} /> : null;
    return out;
  }, [def, node]);

  const templates = useMemo(() => {
    const out: Record<string, (item: unknown, index: number) => ReactNode> = {};
    for (const name of def.templates) {
      const template = node.templates[name];
      out[name] = (item, index) =>
        template ? (
          <TemplateItem key={frameKey(item, index)} node={template} frame={frame} item={item} index={index} />
        ) : null;
    }
    return out;
  }, [def, node, frame]);

  // Lifecycle events fire once per mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount/unmount only
  useEffect(() => {
    if (node.on.appear?.length) void runtime.run(node.on.appear, frame, undefined, node.id);
    return () => {
      if (node.on.disappear?.length) void runtime.run(node.on.disappear, frame, undefined, node.id);
    };
  }, []);

  const finalProps: Record<string, unknown> = { ...impl.defaults };
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value !== null && value !== undefined) finalProps[key] = value;
  }
  if (bindPath && def.bind && bound !== undefined && bound !== null) finalProps[def.bind.prop] = bound;
  if (autoError && typeof formError === 'string') finalProps.error = formError;
  if (field?.required && 'required' in shape && !('required' in own)) finalProps.required = true;
  Object.assign(finalProps, handlers);
  finalProps.slots = slots;
  finalProps.templates = templates;
  finalProps.nodeId = node.id;
  if (node.meta) finalProps.meta = node.meta;
  if (a11y && Object.keys(a11y).length) finalProps.a11y = a11y;
  if (def.children && node.children.length) finalProps.children = <NodeList nodes={node.children} />;

  if (debug) devCheck(runtime, node, impl, finalProps);
  return createElement(impl.Component, finalProps);
}

const bindCache = new Map<string, CompiledValue>();

/** `forms.<form>.shown["<field>"]` as a compiled member chain. */
function formErrorExpression(form: string, field: string): CompiledValue {
  const key = `forms\u0000${form}\u0000${field}`;
  let cv = bindCache.get(key);
  if (!cv) {
    let ast: any = { t: 'id', name: 'forms' };
    for (const segment of [form, 'shown', field])
      ast = { t: 'mem', obj: ast, prop: { t: 'lit', v: segment }, computed: false };
    cv = { k: 'e', ast, src: `forms.${form}.shown[${JSON.stringify(field)}]` };
    bindCache.set(key, cv);
  }
  return cv;
}

/** `state.<path>` as a compiled member chain. */
function bindExpression(path: string): CompiledValue {
  let cv = bindCache.get(path);
  if (!cv) {
    let ast: any = { t: 'id', name: 'state' };
    for (const segment of path.split('.'))
      ast = { t: 'mem', obj: ast, prop: { t: 'lit', v: segment }, computed: false };
    cv = { k: 'e', ast, src: `state.${path}` };
    bindCache.set(path, cv);
  }
  return cv;
}

function devCheck(
  runtime: ScreenRuntime,
  node: CompiledNode,
  impl: ImplementedComponent,
  props: Record<string, unknown>,
) {
  const { slots: _s, templates: _t, nodeId: _n, children: _c, a11y: _a, meta: _m, ...rest } = props;
  const plain = Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== 'function'));
  const result = impl.def.props.safeParse(plain);
  if (!result.success) {
    runtime.reportOnce(`props:${node.id}:${result.error.message}`, {
      type: 'log',
      level: 'warn',
      message: `Props of "${node.id}" (${node.type}) don't match its schema: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      nodeId: node.id,
    });
  }
}
