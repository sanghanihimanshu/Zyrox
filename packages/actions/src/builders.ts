import type {
  AlertAction,
  AppAction,
  BackAction,
  Button,
  ButtonStyle,
  CloseSheetAction,
  Json,
  NavigateAction,
  OpenUrlAction,
  Presentation,
  RefreshAction,
  SetErrorsAction,
  SetStateAction,
  SheetAction,
  SheetContent,
  ToastAction,
  ToastTone,
  TrackAction,
  UiAction,
  UiMessage,
  UiTrigger,
  WithActions,
} from './types';

type Params = Record<string, Json>;

/** Builders for UI actions. Plain objects: send them as JSON from any framework. */
export const ui = {
  /** Opens a screen. */
  navigate(
    to: string,
    params?: Params,
    options: { presentation?: Presentation; transition?: string } = {},
  ): NavigateAction {
    return { do: 'navigate', to, ...(params ? { params } : {}), ...options };
  },
  /** Replaces the current screen (a redirect). */
  redirect(to: string, params?: Params): NavigateAction {
    return ui.navigate(to, params, { presentation: 'replace' });
  },
  /** Clears the history and opens `to` (e.g. sign-in after a session expired). */
  reset(to: string, params?: Params): NavigateAction {
    return ui.navigate(to, params, { presentation: 'reset' });
  },
  back(result?: Json): BackAction {
    return result === undefined ? { do: 'back' } : { do: 'back', result };
  },
  openUrl(url: string): OpenUrlAction {
    return { do: 'openUrl', url };
  },
  /** A sheet with a Zyrox screen, an inline document or content. */
  sheet(sheet: Omit<SheetAction, 'do'>): SheetAction {
    return { do: 'sheet', ...sheet };
  },
  /** A sheet with plain content: title, message, image, buttons. */
  message(content: SheetContent, options: Omit<SheetAction, 'do' | 'content'> = {}): SheetAction {
    return { do: 'sheet', ...options, content };
  },
  closeSheet(id?: string, result?: Json): CloseSheetAction {
    return {
      do: 'closeSheet',
      ...(id !== undefined ? { id } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  },
  alert(title: string, message?: string, buttons?: Button[]): AlertAction {
    return { do: 'alert', title, ...(message ? { message } : {}), ...(buttons ? { buttons } : {}) };
  },
  /** An alert with Cancel and a confirming button that runs `actions`. */
  confirm(
    title: string,
    message: string | undefined,
    confirm: { label: string; actions: UiAction[]; destructive?: boolean; cancel?: string },
  ): AlertAction {
    return ui.alert(title, message, [
      { label: confirm.cancel ?? 'Cancel', style: 'cancel' },
      {
        label: confirm.label,
        style: confirm.destructive ? 'destructive' : 'primary',
        actions: confirm.actions,
      },
    ]);
  },
  toast(
    message: string,
    options: { tone?: ToastTone; duration?: number; action?: { label: string; actions?: UiAction[] } } = {},
  ): ToastAction {
    return { do: 'toast', message, ...options };
  },
  button(label: string, actions?: UiAction[], style?: ButtonStyle): Button {
    return { label, ...(style ? { style } : {}), ...(actions ? { actions } : {}) };
  },
  refresh(data?: string): RefreshAction {
    return data === undefined ? { do: 'refresh' } : { do: 'refresh', data };
  },
  track(event: string, props?: Params): TrackAction {
    return { do: 'track', event, ...(props ? { props } : {}) };
  },
  setState(path: string, value: Json): SetStateAction {
    return { do: 'setState', path, value };
  },
  /** Field errors for a form of the current screen. */
  setErrors(form: string, errors: Record<string, string>): SetErrorsAction {
    return { do: 'setErrors', form, errors };
  },
  /** An action your app registered (it must be in the app's `remoteActions`). */
  action(name: string, args: Record<string, unknown> = {}): AppAction {
    return { ...args, do: name };
  },
};

/** Attaches actions to an API response: `{ ...body, $actions }`. */
export function withActions<T extends object>(
  body: T,
  ...actions: (UiAction | UiAction[])[]
): WithActions<T> {
  const existing = (body as { $actions?: UiAction[] }).$actions ?? [];
  return { ...body, $actions: [...existing, ...actions.flat()] };
}

/** A message for a stream, push or poll. `expiresIn` is in seconds. */
export function uiMessage(
  actions: UiAction[] = [],
  options: { id?: string; expiresIn?: number; expiresAt?: string | number; triggers?: UiTrigger[] } = {},
): UiMessage {
  const message: UiMessage = {};
  if (options.id !== undefined) message.id = options.id;
  if (actions.length) message.actions = actions;
  if (options.triggers) message.triggers = options.triggers;
  if (options.expiresIn !== undefined)
    message.expiresAt = new Date(Date.now() + options.expiresIn * 1000).toISOString();
  else if (options.expiresAt !== undefined) message.expiresAt = options.expiresAt;
  return message;
}

/** A trigger rule (typed helper). */
export function trigger(rule: UiTrigger): UiTrigger {
  return rule;
}
