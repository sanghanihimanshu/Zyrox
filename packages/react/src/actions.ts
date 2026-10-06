import { compileActions, parseUiMessage, type SheetResult, timeOfMessage } from '@zyrox/core';
import type { Action, SheetAction, ToastAction } from '@zyrox/protocol';
import { useMemo } from 'react';
import { useZyrox } from './context';

export interface ZyroxActions {
  /** Runs actions from your own code: any action, with expressions, like a document's. */
  run(actions: readonly Action[], event?: unknown): Promise<boolean>;
  /**
   * Runs what your backend sent: an API response with `$actions`, a message (`{ id, actions,
   * triggers, expiresAt }`), push data (`{ zyrox: "<json>" }`) or a list. Taken literally and
   * limited to `remoteActions`. Use it in your API client for screens that aren't Zyrox screens.
   */
  handle(message: unknown): Promise<boolean>;
  /** Reports one of your own screens, for trigger rules and observers. */
  screenView(screen: string, params?: Record<string, unknown>): void;
  /** Reports an event, for trigger rules and observers. */
  track(event: string, props?: Record<string, unknown>): void;
  sheet(sheet: Omit<SheetAction, 'do'>): Promise<boolean>;
  toast(message: string, options?: Omit<ToastAction, 'do' | 'message'>): Promise<boolean>;
  /** Closes the sheet with `id`, or the top one. */
  closeSheet(id?: string, result?: unknown): boolean;
}

export type { SheetResult };

/** Sheets, toasts, alerts and backend actions from anywhere in your app, not only Zyrox screens. */
export function useZyroxActions(): ZyroxActions {
  const { appRuntime, overlays, receiver } = useZyrox();
  return useMemo<ZyroxActions>(() => {
    const run = (actions: readonly Action[], event?: unknown) => {
      const problems: { message: string }[] = [];
      const compiled = compileActions(actions, problems);
      for (const problem of problems)
        appRuntime.emit({ type: 'error', kind: 'expression', message: problem.message, origin: 'app' });
      return appRuntime.run(compiled, null, event);
    };
    return {
      run,
      handle: async (input) => {
        if (receiver.current) return receiver.current(input);
        const message = parseUiMessage(input);
        if (!message?.actions || timeOfMessage(message) < Date.now()) return false;
        return appRuntime.runRemote(message.actions);
      },
      screenView: (screen, params = {}) =>
        appRuntime.emit({ type: 'screen_view', screen, params, origin: 'app' }),
      track: (event, props = {}) => appRuntime.emit({ type: 'track', name: event, props, origin: 'app' }),
      sheet: (sheet) => run([{ ...sheet, do: 'sheet' } as Action]),
      toast: (message, options = {}) => run([{ ...options, do: 'toast', message } as Action]),
      closeSheet: (id, result) => overlays.closeSheet(id, result),
    };
  }, [appRuntime, overlays, receiver]);
}
