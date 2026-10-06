/** JSON values. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** How a screen opens; the app's navigator decides what each means. */
export type Presentation = 'push' | 'replace' | 'modal' | 'sheet' | 'reset';

export type ButtonStyle = 'default' | 'primary' | 'cancel' | 'destructive';

/** A button of an alert, a message sheet or a toast. */
export interface Button {
  label: string;
  style?: ButtonStyle;
  /** Run when pressed. */
  actions?: UiAction[];
}

/** Opens a screen of the app (a Zyrox document key or any route name the app maps). */
export interface NavigateAction {
  do: 'navigate';
  to: string;
  params?: Record<string, Json>;
  /** `replace` redirects; `reset` clears the history (e.g. to sign-in). Default `push`. */
  presentation?: Presentation;
  transition?: string;
}

export interface BackAction {
  do: 'back';
  result?: Json;
}

export interface OpenUrlAction {
  do: 'openUrl';
  url: string;
}

/** Sheet content without a document: rendered by the app's message component. */
export interface SheetContent {
  title?: string;
  message?: string;
  /** Image URL. */
  image?: string;
  buttons?: Button[];
}

/** A bottom sheet: a Zyrox screen, an inline document, or plain content. */
export interface SheetAction {
  do: 'sheet';
  /** Name it to close or replace it (`closeSheet`); opening an open id replaces it. */
  id?: string;
  /** Zyrox document key. */
  screen?: string;
  /** A complete Zyrox document (`{ zyrox: 1, kind: 'screen', key, root }`). */
  document?: { zyrox: 1; kind: 'screen' | 'block'; key: string; root: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  params?: Record<string, Json>;
  content?: SheetContent;
  title?: string;
  size?: 'auto' | 'half' | 'full';
  /** Default `true`. */
  dismissible?: boolean;
  /** Run when it closes. */
  onClose?: UiAction[];
}

export interface CloseSheetAction {
  do: 'closeSheet';
  id?: string;
  result?: Json;
}

/** A dialog; the pressed button's actions run. */
export interface AlertAction {
  do: 'alert';
  title: string;
  message?: string;
  /** Default: one "OK". */
  buttons?: Button[];
}

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  do: 'toast';
  message: string;
  tone?: ToastTone;
  /** Milliseconds. Default 3000. */
  duration?: number;
  action?: { label: string; actions?: UiAction[] };
}

/** Re-fetches a data source of the screen (or all of them). */
export interface RefreshAction {
  do: 'refresh';
  data?: string;
}

/** Reports an analytics event through the app's observers. */
export interface TrackAction {
  do: 'track';
  event: string;
  props?: Record<string, Json>;
}

/** Writes screen state (`path` relative to `state`). */
export interface SetStateAction {
  do: 'setState';
  path: string;
  value?: Json;
}

export interface SetLocaleAction {
  do: 'setLocale';
  locale: string;
}

/** Shows field errors on a form of the screen. */
export interface SetErrorsAction {
  do: 'setErrors';
  form: string;
  errors: Record<string, string> | { field: string; message: string }[];
}

export interface ResetFormAction {
  do: 'resetForm';
  form: string;
  values?: Json;
}

export interface IfAction {
  do: 'if';
  cond: Json;
  then?: UiAction[];
  else?: UiAction[];
}

export type BuiltinUiAction =
  | NavigateAction
  | BackAction
  | OpenUrlAction
  | SheetAction
  | CloseSheetAction
  | AlertAction
  | ToastAction
  | RefreshAction
  | TrackAction
  | SetStateAction
  | SetLocaleAction
  | SetErrorsAction
  | ResetFormAction
  | IfAction;

/** An action the app registered itself (allowed only if the app lists it in `remoteActions`). */
export interface AppAction {
  do: string;
  [arg: string]: unknown;
}

export type UiAction = BuiltinUiAction | AppAction;

/**
 * Shown when the app reports an event that matches: evaluated on the device. Conditions and
 * action values may use expressions: `{{ event.props.total }}`, `{{ app.user.plan }}`.
 */
export interface UiTrigger {
  /** Stable id: `once`, `cooldown` and limits count per id. */
  id: string;
  on: 'screen_view' | 'track' | 'app_open' | 'foreground';
  /** Screen key (`screen_view`) or event name (`track`). */
  name?: string;
  /** Only while this screen is shown. */
  screen?: string;
  /** Expression on `event` (`name`, `screen`, `params`, `props`), `app`, `device`. */
  if?: string;
  /** Once per install. */
  once?: boolean;
  /** Seconds between fires. */
  cooldown?: number;
  maxPerSession?: number;
  /** Milliseconds to wait; skipped if the user left the screen. */
  delay?: number;
  startsAt?: string | number;
  endsAt?: string | number;
  actions: UiAction[];
}

/** One message over a stream, a push notification or a poll. */
export interface UiMessage {
  /** Runs at most once per install: safe to resend. */
  id?: string;
  actions?: UiAction[];
  /** Replaces the app's trigger rules. */
  triggers?: UiTrigger[];
  /** Ignored after this time (ISO date or epoch milliseconds). */
  expiresAt?: string | number;
}

/** Any API response with UI actions attached. */
export type WithActions<T> = T & { $actions: UiAction[] };
