import type { HelperTree, HostAction, HostActionContext, Observer } from '@zyrox/core';
import {
  type ActionDef,
  buildManifest,
  type ComponentDef,
  type Manifest,
  type Motion,
  type z,
} from '@zyrox/protocol';
import type { ComponentType, ReactNode } from 'react';

// --- Component props as seen by your implementation ---------------------------------------------

type Handler<S> = S extends z.ZodUnknown
  ? (payload?: unknown) => void
  : (payload: z.output<S & z.ZodType>) => void;

/** Drops index signatures so only declared event names remain. */
type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

export type EventHandlers<E> = {
  [K in KnownKeys<E> & string as `on${Capitalize<K>}`]?: Handler<E[K & keyof E]>;
};

export interface A11yProps {
  label?: string;
  hint?: string;
  role?: string;
}

/** Props Zyrox passes to an implementation of `D`. Defaults from the schema are applied. */
export type ZyroxComponentProps<D extends ComponentDef> = z.output<D['props']> &
  EventHandlers<D['events']> & {
    /** Rendered default slot (when the definition has `children: true`). */
    children?: ReactNode;
    /** Rendered named slots; `null` when the document leaves a slot empty. */
    slots: Record<D['slots'][number], ReactNode>;
    /** Item renderers, e.g. for virtualized lists: `templates.item(item, index)`. */
    templates: Record<D['templates'][number], (item: unknown, index: number) => ReactNode>;
    a11y?: A11yProps;
    /** The document node id, handy for test ids. */
    nodeId: string;
    meta?: Record<string, unknown>;
  };

export interface ImplementedComponent<D extends ComponentDef = ComponentDef> {
  readonly kind: 'implemented-component';
  readonly def: D;
  readonly Component: ComponentType<any>;
  /** Default prop values from the schema, applied when a prop is missing or `null`. */
  readonly defaults: Readonly<Record<string, unknown>>;
}

function schemaDefaults(def: ComponentDef): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(def.props.shape as Record<string, z.ZodType>)) {
    const result = schema.safeParse(undefined);
    if (result.success && result.data !== undefined) defaults[key] = result.data;
  }
  return defaults;
}

/** Connects a definition to your React (DOM or Native) component. */
export function implement<D extends ComponentDef>(
  def: D,
  Component: ComponentType<ZyroxComponentProps<D>>,
): ImplementedComponent<D> {
  return { kind: 'implemented-component', def, Component, defaults: schemaDefaults(def) };
}

export interface ImplementedAction<A extends ActionDef = ActionDef> {
  readonly kind: 'implemented-action';
  readonly def: A;
  readonly run: HostAction;
}

/** Connects an action definition to the code that runs it in your app. */
export function implementAction<A extends ActionDef>(
  def: A,
  run: (args: z.output<A['args']>, ctx: HostActionContext) => unknown,
): ImplementedAction<A> {
  return { kind: 'implemented-action', def, run: run as HostAction };
}

// --- Motion --------------------------------------------------------------------------------------

export interface MotionItemProps {
  motion: Motion;
  /** Whether the node should be shown. Play `motion.exit` when it turns false. */
  visible: boolean;
  nodeId: string;
  children?: ReactNode;
}

/**
 * Maps `motion` presets to your animation library (Reanimated, Framer Motion, CSS…).
 * Zyrox never animates anything itself.
 */
export interface MotionAdapter {
  /** Preset names this adapter understands (reported in the manifest). */
  presets: readonly string[];
  /** Wraps every node that has `motion`. */
  Item: ComponentType<MotionItemProps>;
  /** Wraps the items of a repeated node with `motion` (e.g. Framer's `AnimatePresence`). */
  Group?: ComponentType<{ children?: ReactNode }>;
}

// --- Registry & plugins --------------------------------------------------------------------------

export interface RegistryInput {
  components?: readonly ImplementedComponent<any>[];
  actions?: readonly ImplementedAction<any>[];
  /** Expression helpers, e.g. `{ t: i18next.t }`. They override built-ins with the same name. */
  helpers?: HelperTree;
  observers?: readonly Observer[];
  motion?: MotionAdapter;
  /** Transition names your navigator supports (reported in the manifest). */
  transitions?: readonly string[];
  /** Your design tokens (colors, spacing…), reported in the manifest for the dashboard and AI agents. */
  tokens?: Record<string, Record<string, string | number>>;
  /** Bundles of the above, merged first. Your own entries override plugin entries. */
  plugins?: readonly ZyroxPlugin[];
}

export interface ZyroxPlugin extends RegistryInput {
  name: string;
}

export interface Registry {
  readonly components: ReadonlyMap<string, ImplementedComponent>;
  readonly actions: Readonly<Record<string, HostAction>>;
  readonly helpers: HelperTree;
  readonly observers: readonly Observer[];
  readonly motion?: MotionAdapter;
  readonly transitions: readonly string[];
  /** What this app build supports. Sent to the server as a hash. */
  readonly manifest: Manifest;
}

/** Packages components, actions, helpers, observers or a motion adapter for reuse. */
export function definePlugin(plugin: ZyroxPlugin): ZyroxPlugin {
  return plugin;
}

function helperNameList(tree: HelperTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'function' ? [`${prefix}${key}`] : helperNameList(value, `${prefix}${key}.`),
  );
}

export function createRegistry(input: RegistryInput): Registry {
  const layers = [...(input.plugins ?? []).flatMap((p) => [...(p.plugins ?? []), p]), input];
  const components = new Map<string, ImplementedComponent>();
  const actions: Record<string, HostAction> = {};
  const actionDefs = new Map<string, ActionDef>();
  let helpers: HelperTree = {};
  const observers: Observer[] = [];
  let motion: MotionAdapter | undefined;
  const transitions = new Set<string>();
  const tokens: Record<string, Record<string, string | number>> = {};
  for (const layer of layers) {
    for (const c of layer.components ?? []) components.set(c.def.name, c);
    for (const a of layer.actions ?? []) {
      actions[a.def.name] = a.run;
      actionDefs.set(a.def.name, a.def);
    }
    helpers = { ...helpers, ...layer.helpers };
    observers.push(...(layer.observers ?? []));
    if (layer.motion) motion = layer.motion;
    for (const t of layer.transitions ?? []) transitions.add(t);
    for (const [group, values] of Object.entries(layer.tokens ?? {}))
      tokens[group] = { ...tokens[group], ...values };
  }
  let manifest: Manifest | undefined;
  return {
    components,
    actions,
    helpers,
    observers,
    motion,
    transitions: [...transitions],
    get manifest() {
      manifest ??= buildManifest({
        components: [...components.values()].map((c) => c.def),
        actions: [...actionDefs.values()],
        helpers: helperNameList(helpers),
        motions: motion?.presets ?? [],
        transitions: [...transitions],
        tokens,
      });
      return manifest;
    },
  };
}
