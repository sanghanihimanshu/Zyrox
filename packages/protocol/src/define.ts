import type { z } from 'zod';

type AnyObjectSchema = z.ZodObject<any>;
type EventsInput = readonly string[] | Readonly<Record<string, z.ZodType>>;

export type NormalizeEvents<EI> = EI extends readonly (infer K extends string)[]
  ? { [key in K]: z.ZodUnknown }
  : EI extends Readonly<Record<string, z.ZodType>>
    ? EI
    : {};

export interface ComponentDef<
  P extends AnyObjectSchema = AnyObjectSchema,
  E extends Record<string, z.ZodType> = Record<string, z.ZodType>,
  S extends string = string,
  T extends string = string,
> {
  readonly kind: 'component';
  readonly name: string;
  readonly description?: string;
  /** Where the implementation lives, e.g. `src/components/ProductCard.tsx`. */
  readonly source?: string;
  readonly props: P;
  readonly events: E;
  /** Whether the component renders a default `children` slot. */
  readonly children: boolean;
  readonly slots: readonly S[];
  readonly templates: readonly T[];
  readonly bind?: { prop: string; event: string };
}

export interface ComponentDefInput<
  P extends AnyObjectSchema,
  EI extends EventsInput,
  S extends readonly string[],
  T extends readonly string[],
> {
  name: string;
  /** Shown in the dashboard palette and given to the AI assistant. */
  description?: string;
  /** Where the implementation lives (shown to agents, like Figma's Code Connect). */
  source?: string;
  props: P;
  /** Event names (`['press']`) or event names mapped to payload schemas. */
  events?: EI;
  children?: boolean;
  slots?: S;
  templates?: T;
  /** Makes the component bindable with `"bind": "<state path>"`. */
  bind?: { prop: keyof z.input<P> & string; event: keyof NormalizeEvents<EI> & string };
}

const componentName = /^[A-Za-z][A-Za-z0-9_.]*$/;

/**
 * Describes a component's server-facing contract: its props schema, events, slots and templates.
 * Keep definitions free of React imports so the CLI can load them in Node.
 */
export function defineComponent<
  P extends AnyObjectSchema,
  const EI extends EventsInput = [],
  const S extends readonly string[] = [],
  const T extends readonly string[] = [],
>(
  input: ComponentDefInput<P, EI, S, T>,
): ComponentDef<P, NormalizeEvents<EI> & Record<string, z.ZodType>, S[number], T[number]> {
  if (!componentName.test(input.name)) throw new Error(`Invalid component name "${input.name}"`);
  return {
    kind: 'component',
    name: input.name,
    description: input.description,
    source: input.source,
    props: input.props,
    events: normalizeEvents(input.events) as any,
    children: input.children ?? false,
    slots: (input.slots ?? []) as any,
    templates: (input.templates ?? []) as any,
    bind: input.bind,
  };
}

function normalizeEvents(events: EventsInput | undefined): Record<string, z.ZodType | null> {
  if (!events) return {};
  if (Array.isArray(events)) return Object.fromEntries(events.map((name) => [name, null]));
  return { ...(events as Record<string, z.ZodType>) };
}

export interface ActionDef<A extends AnyObjectSchema = AnyObjectSchema> {
  readonly kind: 'action';
  readonly name: string;
  readonly description?: string;
  readonly args: A;
}

/** Describes a host action that documents can call with `{ "do": "<name>", ...args }`. */
export function defineAction<A extends AnyObjectSchema>(input: {
  name: string;
  description?: string;
  args: A;
}): ActionDef<A> {
  if (!componentName.test(input.name)) throw new Error(`Invalid action name "${input.name}"`);
  return { kind: 'action', name: input.name, description: input.description, args: input.args };
}

interface ExtendBase<EI extends EventsInput, S extends readonly string[], T extends readonly string[]> {
  name: string;
  description?: string;
  source?: string;
  /** Extra events, merged with the base events. */
  events?: EI;
  children?: boolean;
  /** Extra slots and templates, merged with the base ones. */
  slots?: S;
  templates?: T;
  /** Replace the binding, or `null` to remove it. */
  bind?: { prop: string; event: string } | null;
}

export interface ExtendComponentInput<
  P extends AnyObjectSchema,
  NP extends AnyObjectSchema,
  EI extends EventsInput,
  S extends readonly string[],
  T extends readonly string[],
> extends ExtendBase<EI, S, T> {
  /** Extra prop fields (merged over the base props), or a function returning the new props schema. */
  props?: z.ZodRawShape | ((base: P) => NP);
}

type Extended<
  NP extends AnyObjectSchema,
  E extends Record<string, z.ZodType>,
  S0 extends string,
  T0 extends string,
  EI extends EventsInput,
  S extends readonly string[],
  T extends readonly string[],
> = ComponentDef<NP, E & NormalizeEvents<EI> & Record<string, z.ZodType>, S0 | S[number], T0 | T[number]>;

/**
 * Derives a new component definition from an existing one: add or override props, add events,
 * slots and templates. The base definition is not changed.
 *
 * ```ts
 * const PromoCardDef = extendComponent(CardDef, {
 *   name: 'PromoCard',
 *   props: { discount: z.number() },
 *   events: ['dismiss'],
 * });
 * ```
 */
export function extendComponent<
  P extends AnyObjectSchema,
  E extends Record<string, z.ZodType>,
  S0 extends string,
  T0 extends string,
  NP extends AnyObjectSchema,
  const EI extends EventsInput = [],
  const S extends readonly string[] = [],
  const T extends readonly string[] = [],
>(
  base: ComponentDef<P, E, S0, T0>,
  input: ExtendBase<EI, S, T> & { props: (base: P) => NP },
): Extended<NP, E, S0, T0, EI, S, T>;
export function extendComponent<
  P extends AnyObjectSchema,
  E extends Record<string, z.ZodType>,
  S0 extends string,
  T0 extends string,
  Sh extends z.ZodRawShape = {},
  const EI extends EventsInput = [],
  const S extends readonly string[] = [],
  const T extends readonly string[] = [],
>(
  base: ComponentDef<P, E, S0, T0>,
  input: ExtendBase<EI, S, T> & { props?: Sh },
): Extended<z.ZodObject<Omit<P['shape'], keyof Sh> & Sh>, E, S0, T0, EI, S, T>;
export function extendComponent(
  base: ComponentDef,
  input: ExtendComponentInput<
    AnyObjectSchema,
    AnyObjectSchema,
    EventsInput,
    readonly string[],
    readonly string[]
  >,
): ComponentDef {
  if (!componentName.test(input.name)) throw new Error(`Invalid component name "${input.name}"`);
  const props =
    typeof input.props === 'function'
      ? input.props(base.props)
      : input.props
        ? base.props.extend(input.props)
        : base.props;
  const unique = (a: readonly string[], b: readonly string[] = []) => [...new Set([...a, ...b])];
  return {
    kind: 'component',
    name: input.name,
    description: input.description ?? base.description,
    source: input.source,
    props,
    events: { ...base.events, ...normalizeEvents(input.events) } as Record<string, z.ZodType>,
    children: input.children ?? base.children,
    slots: unique(base.slots, input.slots),
    templates: unique(base.templates, input.templates),
    bind: input.bind === null ? undefined : (input.bind ?? base.bind),
  };
}
