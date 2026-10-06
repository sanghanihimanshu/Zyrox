import type { Action } from '@zyrox/protocol';

/**
 * Event-triggered UI from your backend: when the app reports an event that matches, the actions
 * run (a sheet after adding to cart, a toast on the cart screen…). Evaluated on the device.
 */
export interface UiTrigger {
  /** Stable id: `once`, `cooldown` and limits are counted per id. */
  id: string;
  /**
   * `screen_view` (`name` = screen key), `track` (`name` = event name), `app_open` (first
   * load of the rules in a session) or `foreground`.
   */
  on: 'screen_view' | 'track' | 'app_open' | 'foreground';
  name?: string;
  /** Only while this screen is shown. */
  screen?: string;
  /** Expression on `event` (`name`, `screen`, `params`, `props`), `app` and `device`. */
  if?: string;
  /** Fire at most once per install. */
  once?: boolean;
  /** Seconds before it may fire again. */
  cooldown?: number;
  /** Fire at most this many times per app session. */
  maxPerSession?: number;
  /** Milliseconds to wait first; skipped if the user left the screen meanwhile. */
  delay?: number;
  /** Active window (ISO date or epoch milliseconds). */
  startsAt?: string | number;
  endsAt?: string | number;
  /** Run with expressions on (`{{ event.props.total }}`), like document actions. */
  actions: Action[];
}

/** What your backend sends over a stream, a push notification or a poll. */
export interface UiMessage {
  /** Runs at most once per install (remembered for a week): safe to resend. */
  id?: string;
  /** Run as sent: strings are not expressions. */
  actions?: Action[];
  /** Replaces the trigger rules. */
  triggers?: UiTrigger[];
  /** Ignored after this time (ISO date or epoch milliseconds), e.g. a push delivered late. */
  expiresAt?: string | number;
}

export function timeOf(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

/** When a message stops being valid (`Infinity` without `expiresAt`). */
export function timeOfMessage(message: UiMessage): number {
  return timeOf(message.expiresAt) ?? Number.POSITIVE_INFINITY;
}

/**
 * Reads a message in any of the shapes a backend may send: a `UiMessage`, an API response with
 * `$actions`, a bare list of actions, push data (`{ zyrox: "<json>" }`) or JSON text of those.
 */
export function parseUiMessage(input: unknown): UiMessage | undefined {
  let value = input;
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) return { actions: value as Action[] };
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.zyrox === 'string' || (v.zyrox && typeof v.zyrox === 'object')) return parseUiMessage(v.zyrox);
  const message: UiMessage = {};
  if (typeof v.id === 'string' || typeof v.id === 'number') message.id = String(v.id);
  const actions = v.actions ?? v.$actions;
  if (Array.isArray(actions)) message.actions = actions as Action[];
  if (Array.isArray(v.triggers)) message.triggers = v.triggers as UiTrigger[];
  if (typeof v.expiresAt === 'string' || typeof v.expiresAt === 'number') message.expiresAt = v.expiresAt;
  return message.actions || message.triggers ? message : undefined;
}
