import { type CSSProperties, type ReactNode, useEffect, useId, useRef } from 'react';
import type { AlertProps, MessageProps, OverlayComponents, SheetProps, ToastsProps } from './overlay-host';
import { type OverlayTheme, type OverlayThemeInput, themeHook } from './overlay-theme';

export type { OverlayComponents, OverlayTheme, OverlayThemeInput };

/**
 * Plain, accessible sheets, alerts and toasts for the web. Pass the result to
 * `<ZyroxProvider overlays>`, or replace any of them with your design system's components.
 */
export function createOverlays(theme: OverlayThemeInput = {}): OverlayComponents {
  const useTheme = themeHook(theme);

  const buttonStyle = (t: OverlayTheme, style: string, block: boolean): CSSProperties => ({
    font: 'inherit',
    fontWeight: 600,
    cursor: 'pointer',
    padding: '10px 16px',
    borderRadius: Math.min(t.radius, 12),
    width: block ? '100%' : undefined,
    border: style === 'primary' ? 'none' : `1px solid ${t.border}`,
    background: style === 'primary' ? t.primary : 'transparent',
    color: style === 'primary' ? t.primaryText : style === 'destructive' ? t.danger : t.text,
  });

  function useEscape(enabled: boolean, onEscape: () => void) {
    const latest = useRef(onEscape);
    latest.current = onEscape;
    useEffect(() => {
      if (!enabled) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') latest.current();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [enabled]);
  }

  function Sheet({ title, size, dismissible, onDismiss, children }: SheetProps): ReactNode {
    const t = useTheme();
    const panel = useRef<HTMLDivElement>(null);
    useEscape(dismissible, onDismiss);
    useEffect(() => {
      panel.current?.focus();
      panel.current?.animate?.([{ transform: 'translateY(100%)' }, { transform: 'none' }], {
        duration: 220,
        easing: 'cubic-bezier(.2,.8,.2,1)',
      });
    }, []);
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          fontFamily: t.fontFamily,
        }}
      >
        <button
          type="button"
          aria-label="Close"
          tabIndex={-1}
          onClick={dismissible ? onDismiss : undefined}
          style={{ all: 'unset', position: 'absolute', inset: 0, background: t.backdrop }}
        />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          style={{
            position: 'relative',
            boxSizing: 'border-box',
            width: '100%',
            maxWidth: 640,
            margin: '0 auto',
            maxHeight: '92%',
            height: size === 'half' ? '50%' : size === 'full' ? '92%' : undefined,
            overflow: 'auto',
            padding: 16,
            background: t.background,
            color: t.text,
            borderRadius: `${t.radius}px ${t.radius}px 0 0`,
            outline: 'none',
          }}
        >
          {title || dismissible ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <strong style={{ flex: 1, fontSize: 17 }}>{title}</strong>
              {dismissible ? (
                <button
                  type="button"
                  aria-label="Close"
                  onClick={onDismiss}
                  style={{ ...buttonStyle(t, 'default', false), padding: '2px 10px', border: 'none' }}
                >
                  ✕
                </button>
              ) : null}
            </div>
          ) : null}
          {children}
        </div>
      </div>
    );
  }

  function Alert({ title, message, buttons, onPress, onDismiss }: AlertProps): ReactNode {
    const t = useTheme();
    const id = useId();
    const last = useRef<HTMLButtonElement>(null);
    useEscape(true, onDismiss);
    useEffect(() => last.current?.focus(), []);
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          display: 'grid',
          placeItems: 'center',
          background: t.backdrop,
          fontFamily: t.fontFamily,
        }}
      >
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`${id}-title`}
          aria-describedby={message ? `${id}-message` : undefined}
          style={{
            width: 'min(360px, calc(100% - 32px))',
            boxSizing: 'border-box',
            padding: 20,
            borderRadius: t.radius,
            background: t.background,
            color: t.text,
          }}
        >
          <strong id={`${id}-title`} style={{ display: 'block', fontSize: 17 }}>
            {title}
          </strong>
          {message ? (
            <p id={`${id}-message`} style={{ margin: '8px 0 0', color: t.muted }}>
              {message}
            </p>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            {buttons.map((button, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: buttons are static per alert
                key={i}
                ref={i === buttons.length - 1 ? last : undefined}
                type="button"
                onClick={() => onPress(i)}
                style={buttonStyle(
                  t,
                  i === buttons.length - 1 && button.style === 'default' ? 'primary' : button.style,
                  false,
                )}
              >
                {button.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function Toasts({ toasts, onPress, onDismiss }: ToastsProps): ReactNode {
    const t = useTheme();
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 24,
          zIndex: 1200,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          pointerEvents: 'none',
          fontFamily: t.fontFamily,
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.key}
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              maxWidth: 'calc(100% - 32px)',
              padding: '10px 14px',
              borderRadius: Math.min(t.radius, 12),
              background: t.tones[toast.tone],
              color: '#fff',
              boxShadow: '0 6px 24px rgba(0,0,0,.2)',
            }}
          >
            <span style={{ flex: 1 }}>{toast.message}</span>
            {toast.action ? (
              <button
                type="button"
                onClick={() => onPress(toast.key)}
                style={{ all: 'unset', cursor: 'pointer', fontWeight: 700, textDecoration: 'underline' }}
              >
                {toast.action.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => onDismiss(toast.key)}
              style={{ all: 'unset', cursor: 'pointer', opacity: 0.8 }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    );
  }

  function Message({ title, message, image, buttons, onPress }: MessageProps): ReactNode {
    const t = useTheme();
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'center' }}>
        {image ? (
          <img
            src={image}
            alt=""
            style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 12 }}
          />
        ) : null}
        {title ? <strong style={{ fontSize: 20 }}>{title}</strong> : null}
        {message ? <p style={{ margin: 0, color: t.muted }}>{message}</p> : null}
        {buttons.map((button, i) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: buttons are static per sheet
            key={i}
            type="button"
            onClick={() => onPress(i)}
            style={buttonStyle(t, button.style, true)}
          >
            {button.label}
          </button>
        ))}
      </div>
    );
  }

  return { Sheet, Alert, Toasts, Message };
}

export const defaultOverlays: OverlayComponents = createOverlays();
