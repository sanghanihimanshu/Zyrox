import type { OpenToast, OverlayButton, OverlayController } from '@zyrox/core';
import { type ComponentType, type ReactNode, useSyncExternalStore } from 'react';
import { ZyroxScreen } from './screen';

export interface SheetProps {
  title?: string;
  size: 'auto' | 'half' | 'full';
  dismissible: boolean;
  /** The user closed it (swipe, backdrop, back button). Only call when `dismissible`. */
  onDismiss(): void;
  children: ReactNode;
}

export interface AlertProps {
  title: string;
  message?: string;
  buttons: readonly OverlayButton[];
  onPress(index: number): void;
  /** Closed without a button (back button, Escape). */
  onDismiss(): void;
}

export interface ToastsProps {
  toasts: readonly OpenToast[];
  onPress(key: number): void;
  onDismiss(key: number): void;
}

/** Plain sheet content sent instead of a document: title, message, image, buttons. */
export interface MessageProps {
  title?: string;
  message?: string;
  image?: string;
  buttons: readonly OverlayButton[];
  onPress(index: number): void;
}

/**
 * How sheets, alerts and toasts look: your design system's components, or the defaults from
 * `@zyrox/react/overlays`.
 */
export interface OverlayComponents {
  Sheet: ComponentType<SheetProps>;
  Alert: ComponentType<AlertProps>;
  Toasts: ComponentType<ToastsProps>;
  Message: ComponentType<MessageProps>;
}

export function OverlayHost({
  controller,
  components,
}: {
  controller: OverlayController;
  components: OverlayComponents;
}): ReactNode {
  const { sheets, alerts, toasts } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const { Sheet, Alert, Toasts, Message } = components;
  const alert = alerts[0];
  return (
    <>
      {sheets.map((sheet) => (
        <Sheet
          key={sheet.key}
          title={sheet.title}
          size={sheet.size}
          dismissible={sheet.dismissible}
          onDismiss={() => controller.dismissSheet(sheet.key)}
        >
          {sheet.content ? (
            <Message {...sheet.content} onPress={(index) => controller.pressSheetButton(sheet.key, index)} />
          ) : (
            <ZyroxScreen screen={sheet.screen} document={sheet.document} params={sheet.params} />
          )}
        </Sheet>
      ))}
      {alert ? (
        <Alert
          key={alert.key}
          title={alert.title}
          message={alert.message}
          buttons={alert.buttons}
          onPress={(index) => controller.pressAlert(alert.key, index)}
          onDismiss={() => controller.pressAlert(alert.key)}
        />
      ) : null}
      {toasts.length ? (
        <Toasts
          toasts={toasts}
          onPress={(key) => controller.pressToast(key)}
          onDismiss={(key) => controller.dismissToast(key)}
        />
      ) : null}
    </>
  );
}
