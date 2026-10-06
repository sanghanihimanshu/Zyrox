/** Current protocol major version. Clients ignore documents with a different major. */
export const PROTOCOL_VERSION = 1 as const;

/** Any JSON value. Strings may contain `{{ expression }}` templates. */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

/** A string of the form `"{{ expression }}"` (whole value) or text mixed with `{{ }}` parts. */
export type Expr = string;

export interface A11y {
  label?: Value;
  hint?: Value;
  role?: string;
}

export interface Repeat {
  /** Expression that evaluates to an array. */
  each: Value;
  /** Name of the item variable inside the repeated node. Default `item`. */
  as?: string;
  /** Name of the index variable. Default `index`. */
  index?: string;
  /** Expression for a stable React key. Defaults to the index. */
  key?: Value;
}

/**
 * Animation hints. Zyrox doesn't animate anything itself: your motion adapter (Reanimated,
 * Framer Motion, CSS…) maps these preset names to real animations.
 */
export interface Motion {
  /** Preset played when the node appears (mount, `if` turns true, item added). */
  enter?: string;
  /** Preset played when the node disappears. */
  exit?: string;
  /** Animate layout changes (position/size). `true` uses the adapter's default. */
  layout?: boolean | string;
}

export interface Node {
  /** Stable id, unique within the document. Ops, selection and telemetry address nodes by id. */
  id: string;
  /** Component name from the host registry. */
  type: string;
  props?: Record<string, Value>;
  /** Default slot. */
  children?: Node[];
  /** Named slots, rendered by the runtime and passed to the component as `slots.<name>`. */
  slots?: Record<string, Node[]>;
  /** Item templates, passed to the component as `templates.<name>(item, index)`. */
  templates?: Record<string, Node>;
  /** Event name to the actions it runs. */
  on?: Record<string, Action[]>;
  /** Two-way binding to a state path (relative to `state`, e.g. `form.email`). */
  bind?: string;
  /** Render only when truthy. */
  if?: Value;
  repeat?: Repeat;
  /** Local variables for this node and its descendants. Values are evaluated in the parent scope. */
  with?: Record<string, Value>;
  /** Rendered when the client has no component named `type`. */
  fallback?: Node;
  a11y?: A11y;
  motion?: Motion;
  /** Free-form data for your own tooling (test ids, analytics tags…). Passed to observers, never rendered. */
  meta?: Record<string, Value>;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface SetStateAction {
  do: 'setState';
  /** Dot path relative to `state`. */
  path: string;
  value?: Value;
}
export interface NavigateAction {
  do: 'navigate';
  to: Value;
  params?: Record<string, Value>;
  /** How the destination is shown. Your navigator decides what each one means. Default `push`. */
  presentation?: 'push' | 'replace' | 'modal' | 'sheet' | 'reset';
  /** Transition preset name passed to your navigator (e.g. `slide`, `fade`). */
  transition?: string;
}
export interface BackAction {
  do: 'back';
  /** Optional result handed to your navigator (e.g. for screens opened as a picker). */
  result?: Value;
}
export interface OpenUrlAction {
  do: 'openUrl';
  url: Value;
}
export interface RequestAction {
  do: 'request';
  url: Value;
  method?: HttpMethod;
  headers?: Record<string, Value>;
  body?: Value;
  /** State path to write the response into. */
  into?: string;
  onSuccess?: Action[];
  onError?: Action[];
}
export interface RefreshAction {
  do: 'refresh';
  /** Data source key. Omit to refresh all data sources of the screen. */
  data?: string;
}
export interface TrackAction {
  do: 'track';
  event: Value;
  props?: Record<string, Value>;
}
/**
 * Calls a remote (cloud) function. By default it goes through the Zyrox server, which runs
 * functions registered in code or forwards to your function URL; hosts can route it anywhere.
 */
export interface CallAction {
  do: 'call';
  /** Function name. */
  fn: string;
  args?: Record<string, Value>;
  /** State path to write the result into. */
  into?: string;
  onSuccess?: Action[];
  onError?: Action[];
}
/** Switches the app language at runtime. Missing remote bundles are fetched first. */
export interface SetLocaleAction {
  do: 'setLocale';
  locale: Value;
}
export interface IfAction {
  do: 'if';
  cond: Value;
  then?: Action[];
  else?: Action[];
}
/**
 * Validates a form: shows every field's error and, when the form is invalid, stops the action
 * list (so a following `request` is only sent with valid input).
 */
export interface ValidateAction {
  do: 'validate';
  form: string;
}
/** Puts a form back to its initial values (from `state`) or to `values`, clearing errors. */
export interface ResetFormAction {
  do: 'resetForm';
  form: string;
  values?: Value;
}
/** Shows errors from your API on fields, e.g. `{ "email": "Already registered" }`, until they change. */
export interface SetErrorsAction {
  do: 'setErrors';
  form: string;
  errors: Value;
}
/** A button of an alert, a message sheet or a toast. */
export interface OverlayButton {
  label: Value;
  /** `primary` and `destructive` are styled; `cancel` closes without side effects. Default `default`. */
  style?: 'default' | 'primary' | 'cancel' | 'destructive';
  /** Runs when the button is pressed. */
  actions?: Action[];
}
/**
 * Opens a bottom sheet over the current screen, rendered by your overlay components. It shows a
 * Zyrox screen (`screen`), a document sent inline (`document`, e.g. by your backend), or plain
 * `content` (title, message, image, buttons).
 */
export interface SheetAction {
  do: 'sheet';
  /** Names the sheet so `closeSheet` can target it; opening an id that is open replaces it. */
  id?: string;
  /** Document key, loaded like `<ZyroxScreen screen>`. */
  screen?: Value;
  /** An inline document. Its expressions run in the sheet's own scope, not the caller's. */
  document?: Document;
  params?: Record<string, Value>;
  content?: { title?: Value; message?: Value; image?: Value; buttons?: OverlayButton[] };
  title?: Value;
  size?: 'auto' | 'half' | 'full';
  /** Swipe down, backdrop and back button close it. Default `true`. */
  dismissible?: boolean;
  /** Runs when the sheet closes; `event` is the `closeSheet` result (`undefined` when dismissed). */
  onClose?: Action[];
}
/** Closes the sheet with `id`, or the top one, handing `result` to its `onClose`. */
export interface CloseSheetAction {
  do: 'closeSheet';
  id?: string;
  result?: Value;
}
/** A dialog that waits for a button; the pressed button's actions run before the list continues. */
export interface AlertAction {
  do: 'alert';
  title: Value;
  message?: Value;
  /** Default: a single "OK". */
  buttons?: OverlayButton[];
}
/** A short, non-blocking message, with an optional action button (e.g. "Undo"). */
export interface ToastAction {
  do: 'toast';
  message: Value;
  tone?: 'info' | 'success' | 'warning' | 'danger';
  /** Milliseconds on screen. Default 3000. */
  duration?: number;
  action?: { label: Value; actions?: Action[] };
}
/** An action registered by the host app. All fields except `do` are its arguments. */
export interface CustomAction {
  do: string;
  [arg: string]: Value | undefined;
}

export type BuiltinAction =
  | SetStateAction
  | NavigateAction
  | BackAction
  | OpenUrlAction
  | RequestAction
  | CallAction
  | SetLocaleAction
  | RefreshAction
  | TrackAction
  | IfAction
  | ValidateAction
  | ResetFormAction
  | SetErrorsAction
  | SheetAction
  | CloseSheetAction
  | AlertAction
  | ToastAction;

export type Action = BuiltinAction | CustomAction;

export const BUILTIN_ACTIONS = [
  'setState',
  'navigate',
  'back',
  'openUrl',
  'request',
  'call',
  'setLocale',
  'refresh',
  'track',
  'if',
  'validate',
  'resetForm',
  'setErrors',
  'sheet',
  'closeSheet',
  'alert',
  'toast',
] as const;
export type BuiltinActionName = (typeof BUILTIN_ACTIONS)[number];

/** Events every node supports. The runtime fires them; components don't need to declare them. */
export const LIFECYCLE_EVENTS = ['appear', 'disappear'] as const;

export type RefreshTrigger = 'mount' | 'foreground' | number;

export interface DataSource {
  /** Free-form kind for your fetcher (e.g. `graphql`). Default: plain HTTP. */
  kind?: string;
  /** Fetch only while truthy, e.g. `{{ data.user.id }}` to wait for another source. */
  if?: Value;
  url: Value;
  method?: HttpMethod;
  headers?: Record<string, Value>;
  body?: Value;
  /** When to (re)fetch. Default `["mount"]`. A number is a polling interval in seconds. */
  refresh?: RefreshTrigger[];
  /** Wait this many milliseconds after the request inputs change before fetching (search-as-you-type). */
  debounce?: number;
  /**
   * Seconds to reuse a response for the same request (shared by every screen). Older cached
   * responses still show instantly while a fresh one loads (stale-while-revalidate).
   */
  cache?: number;
  /** Sample response used by the dashboard preview and tests. */
  mock?: Value;
}

export interface ParamDef {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: Value;
}

/** A rule's parameter, with an optional custom message. */
export type RuleValue<T> = T | { value: T; message?: Value };

/**
 * Validation rules for one field. Values and messages may be expressions; inside them `value` is
 * the field's current value. Empty, optional fields skip every rule except `rules`.
 */
export interface FieldRules {
  /** Validate this field only while truthy (conditional fields). */
  if?: Value;
  /** `true` or a custom message. `false` and empty strings count as missing. */
  required?: boolean | Value;
  minLength?: RuleValue<number | Value>;
  maxLength?: RuleValue<number | Value>;
  min?: RuleValue<number | Value>;
  max?: RuleValue<number | Value>;
  /** A regular expression the whole value must match, e.g. `^[0-9]{6}$`. */
  pattern?: RuleValue<string>;
  email?: boolean | Value;
  url?: boolean | Value;
  oneOf?: RuleValue<Value[] | Value>;
  /** Must equal another value, e.g. `"{{ state.signup.password }}"`. */
  equals?: RuleValue<Value>;
  /** Custom checks: the field is invalid when `check` is falsy. Use for cross-field and async results. */
  rules?: { check: Value; message: Value }[];
}

/** A form over `state.<name>`: rules per field (dot paths relative to the form). */
export interface FormDef {
  fields: Record<string, FieldRules>;
  /** When errors appear: once a field was edited (default) or only after `validate`. */
  show?: 'touched' | 'submit';
}

export type DocumentKind = 'screen' | 'block';

export interface Document {
  zyrox: typeof PROTOCOL_VERSION;
  kind: DocumentKind;
  key: string;
  title?: string;
  params?: Record<string, ParamDef>;
  state?: Record<string, Value>;
  data?: Record<string, DataSource>;
  /** Forms over parts of `state`, with validation rules (`forms.<name>` in expressions). */
  forms?: Record<string, FormDef>;
  root: Node;
  /** Free-form data for your own tooling. */
  meta?: Record<string, Value>;
}

/**
 * Where an op inserts or moves a node:
 * `children` (default), `slots.<name>`, `templates.<name>` or `fallback`.
 */
export type SlotRef = string;

export type Op =
  | { op: 'insert'; parent: string; slot?: SlotRef; index?: number; node: Node }
  | { op: 'update'; id: string; set?: Record<string, Value>; unset?: string[] }
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; parent: string; slot?: SlotRef; index?: number }
  | { op: 'doc'; set?: Record<string, Value>; unset?: string[] }
  | { op: 'replace'; document: Document };

/** JSON Schema object (draft 2020-12), as produced by `z.toJSONSchema`. */
export type JsonSchema = { [key: string]: unknown };

export interface ManifestComponent {
  description?: string;
  /** Where the implementation lives (e.g. `src/components/ProductCard.tsx`), for agents and the dashboard. */
  source?: string;
  props: JsonSchema;
  events: Record<string, JsonSchema>;
  children: boolean;
  slots: string[];
  templates: string[];
  bind?: { prop: string; event: string };
}

export interface ManifestAction {
  description?: string;
  args: JsonSchema;
}

export interface ManifestBody {
  protocol: typeof PROTOCOL_VERSION;
  components: Record<string, ManifestComponent>;
  actions: Record<string, ManifestAction>;
  helpers: string[];
  /** Motion preset names the app's motion adapter supports. */
  motions: string[];
  /** Transition names the app's navigator supports. */
  transitions: string[];
  /**
   * Design tokens by group, e.g. `{ color: { primary: '#4f46e5' }, space: { md: 16 } }`.
   * Informational: they help the dashboard and AI agents pick consistent values.
   */
  tokens: Record<string, Record<string, string | number>>;
}

/** What one app build supports. Identified by a hash of its canonical JSON. */
export interface Manifest extends ManifestBody {
  hash: string;
}

/**
 * Translations for one locale. Messages use `{name}` placeholders and ICU-style plurals:
 * `"{count, plural, one {# item} other {# items}}"`.
 */
export interface StringsBundle {
  zyrox: typeof PROTOCOL_VERSION;
  kind: 'strings';
  locale: string;
  messages: Record<string, string>;
}
