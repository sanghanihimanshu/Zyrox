import type { Document } from '@zyrox/protocol';

/**
 * Sheets, alerts and toasts opened by the `sheet`, `alert` and `toast` actions, whether they come
 * from a document, your backend or your own code. Holds what is open; your overlay components
 * (`@zyrox/react/overlays` or your own) render it.
 */

export type ButtonStyle = 'default' | 'primary' | 'cancel' | 'destructive';

export interface OverlayButton {
  label: string;
  style: ButtonStyle;
}

export interface SheetContent {
  title?: string;
  message?: string;
  image?: string;
  buttons: OverlayButton[];
}

export interface SheetRequest {
  id?: string;
  /** Document key to render. */
  screen?: string;
  /** Inline document to render. */
  document?: Document;
  params?: Record<string, unknown>;
  /** Plain content, rendered by your `Message` component. */
  content?: SheetContent;
  title?: string;
  size?: 'auto' | 'half' | 'full';
  dismissible?: boolean;
}

export interface OpenSheet extends SheetRequest {
  /** Unique per opened sheet (React key). */
  key: number;
  dismissible: boolean;
  size: 'auto' | 'half' | 'full';
}

/** How a sheet closed: a content button, `closeSheet` with a result, or dismissed by the user. */
export interface SheetResult {
  button?: number;
  result?: unknown;
  dismissed?: boolean;
}

export interface AlertRequest {
  title: string;
  message?: string;
  buttons: OverlayButton[];
}

export interface OpenAlert extends AlertRequest {
  key: number;
}

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastRequest {
  message: string;
  tone?: ToastTone;
  /** Milliseconds. Default 3000. */
  duration?: number;
  action?: { label: string };
}

export interface OpenToast extends ToastRequest {
  key: number;
  tone: ToastTone;
}

export interface OverlaySnapshot {
  /** Bottom to top. */
  sheets: readonly OpenSheet[];
  /** Waiting alerts; show the first. */
  alerts: readonly OpenAlert[];
  toasts: readonly OpenToast[];
}

/** What the runtime needs to open overlays. */
export interface OverlayHost {
  /** Resolves when the sheet closes. */
  sheet(request: SheetRequest): Promise<SheetResult>;
  closeSheet(id?: string, result?: unknown): boolean;
  /** Resolves with the pressed button's index, or `undefined` when dismissed. */
  alert(request: AlertRequest): Promise<number | undefined>;
  /** Resolves `true` when its action button was pressed. */
  toast(request: ToastRequest): Promise<boolean>;
}

const MAX_TOASTS = 3;
const MAX_SHEETS = 5;

export class OverlayController implements OverlayHost {
  private snapshot: OverlaySnapshot = { sheets: [], alerts: [], toasts: [] };
  private readonly listeners = new Set<() => void>();
  private readonly settle = new Map<number, (value: never) => void>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextKey = 1;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): OverlaySnapshot => this.snapshot;

  private update(next: Partial<OverlaySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private open<T>(key: number, add: () => void): Promise<T> {
    return new Promise<T>((resolve) => {
      this.settle.set(key, resolve as (value: never) => void);
      add();
    });
  }

  private resolve(key: number, value: unknown): void {
    const done = this.settle.get(key);
    this.settle.delete(key);
    done?.(value as never);
  }

  sheet(request: SheetRequest): Promise<SheetResult> {
    const key = this.nextKey++;
    const sheet: OpenSheet = {
      ...request,
      key,
      dismissible: request.dismissible ?? true,
      size: request.size ?? 'auto',
    };
    return this.open(key, () => {
      // Opening an id that is already open replaces it.
      const replaced = request.id ? this.snapshot.sheets.find((s) => s.id === request.id) : undefined;
      if (replaced) this.resolve(replaced.key, { dismissed: true });
      const sheets = this.snapshot.sheets.filter((s) => s !== replaced);
      const dropped = sheets.length >= MAX_SHEETS ? sheets.shift() : undefined;
      if (dropped) this.resolve(dropped.key, { dismissed: true });
      this.update({ sheets: [...sheets, sheet] });
    });
  }

  /** Closes the sheet with `id` (or the top one). Returns whether one was open. */
  closeSheet(id?: string, result?: unknown): boolean {
    const sheets = this.snapshot.sheets;
    const target = id === undefined ? sheets.at(-1) : sheets.find((s) => s.id === id);
    if (!target) return false;
    this.finishSheet(target.key, result === undefined ? {} : { result });
    return true;
  }

  /** The user dismissed a sheet (swipe, backdrop, back button). */
  dismissSheet(key: number): void {
    this.finishSheet(key, { dismissed: true });
  }

  /** A content button of a message sheet was pressed: closes it. */
  pressSheetButton(key: number, index: number): void {
    this.finishSheet(key, { button: index });
  }

  private finishSheet(key: number, result: SheetResult): void {
    if (!this.snapshot.sheets.some((s) => s.key === key)) return;
    this.update({ sheets: this.snapshot.sheets.filter((s) => s.key !== key) });
    this.resolve(key, result);
  }

  alert(request: AlertRequest): Promise<number | undefined> {
    const key = this.nextKey++;
    const buttons = request.buttons.length ? request.buttons : [{ label: 'OK', style: 'default' as const }];
    return this.open(key, () =>
      this.update({ alerts: [...this.snapshot.alerts, { ...request, buttons, key }] }),
    );
  }

  /** A button of the shown alert was pressed (`undefined`: dismissed). */
  pressAlert(key: number, index?: number): void {
    if (!this.snapshot.alerts.some((a) => a.key === key)) return;
    this.update({ alerts: this.snapshot.alerts.filter((a) => a.key !== key) });
    this.resolve(key, index);
  }

  toast(request: ToastRequest): Promise<boolean> {
    const key = this.nextKey++;
    const toast: OpenToast = { ...request, key, tone: request.tone ?? 'info' };
    return this.open(key, () => {
      const toasts = [...this.snapshot.toasts, toast];
      while (toasts.length > MAX_TOASTS) this.endToast(toasts.shift()!.key, false, false);
      this.update({ toasts });
      this.timers.set(
        key,
        setTimeout(() => this.endToast(key, false), Math.max(1000, request.duration ?? 3000)),
      );
    });
  }

  pressToast(key: number): void {
    this.endToast(key, true);
  }

  dismissToast(key: number): void {
    this.endToast(key, false);
  }

  private endToast(key: number, pressed: boolean, publish = true): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (publish) {
      if (!this.snapshot.toasts.some((t) => t.key === key)) return;
      this.update({ toasts: this.snapshot.toasts.filter((t) => t.key !== key) });
    }
    this.resolve(key, pressed);
  }

  /** Closes everything (e.g. on sign-out). */
  clear(): void {
    for (const sheet of this.snapshot.sheets) this.resolve(sheet.key, { dismissed: true });
    for (const alert of this.snapshot.alerts) this.resolve(alert.key, undefined);
    for (const toast of this.snapshot.toasts) this.endToast(toast.key, false, false);
    this.update({ sheets: [], alerts: [], toasts: [] });
  }
}
