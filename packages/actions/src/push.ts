import type { UiAction, UiMessage } from './types';

/**
 * Push data for FCM / APNs / Expo / OneSignal: `{ zyrox: "<json>" }` (FCM data values must be
 * strings, about 4 KB in total). On the device, hand the notification's data to the app
 * (`useZyroxActions().handle(data)` or a `<ZyroxRemote>` source).
 */
export function toPushData(
  input: UiMessage | UiAction[],
  options: { key?: string; maxBytes?: number } = {},
): Record<string, string> {
  const message: UiMessage = Array.isArray(input) ? { actions: input } : input;
  const json = JSON.stringify(message);
  const bytes = new TextEncoder().encode(json).length;
  const max = options.maxBytes ?? 3500;
  if (bytes > max)
    throw new Error(
      `UI message is ${bytes} bytes; push data allows about 4 KB. Send a sheet with a screen key, or let the app fetch the details.`,
    );
  return { [options.key ?? 'zyrox']: json };
}
