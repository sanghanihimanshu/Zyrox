import type { Document, Manifest } from '@wishyor/zyrox-protocol';
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { StableContext, useZyrox } from './context';
import { ZyroxScreen } from './screen';

/** Messages the dashboard canvas sends to the preview frame. */
export type PreviewHostMessage = {
  type: 'zyrox:render';
  document: Document;
  mock?: boolean;
  /** `select` turns clicks into node selection; `interact` lets the screen handle them. */
  mode?: 'select' | 'interact';
  selected?: string | null;
};

/** Messages the preview frame sends back. */
export type PreviewFrameMessage =
  | { type: 'zyrox:ready'; manifest: Manifest }
  | { type: 'zyrox:select'; nodeId: string }
  | { type: 'zyrox:event'; event: unknown };

export interface ZyroxPreviewHostProps {
  /**
   * Origins allowed to drive this frame: your dashboard, e.g. `['https://ui.example.com']`.
   * Required: any other page could otherwise render documents in your app with your users'
   * credentials and read the events back.
   */
  allowedOrigins: readonly string[];
  /** Shown before the dashboard sends a document. */
  placeholder?: ReactNode;
}

function nodeRect(root: HTMLElement, nodeId: string): DOMRect | null {
  const marker = root.querySelector(`[data-zyrox-node="${CSS.escape(nodeId)}"]`);
  if (!marker) return null;
  let top = Number.POSITIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const visit = (el: Element) => {
    const style = getComputedStyle(el);
    if (style.display === 'contents') {
      for (const child of el.children) visit(child);
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  };
  visit(marker);
  return Number.isFinite(top) ? new DOMRect(left, top, right - left, bottom - top) : null;
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function Highlight({ rect, color, label }: { rect: DOMRect | null; color: string; label?: string }) {
  if (!rect) return null;
  const style: CSSProperties = {
    position: 'fixed',
    left: rect.left - 1,
    top: rect.top - 1,
    width: rect.width + 2,
    height: rect.height + 2,
    outline: `2px solid ${color}`,
    pointerEvents: 'none',
    zIndex: 2147483646,
    borderRadius: 2,
  };
  return (
    <div style={style}>
      {label ? (
        <span
          style={{
            position: 'absolute',
            top: rect.top < 18 ? 0 : -18,
            left: -2,
            background: color,
            color: 'white',
            font: '11px system-ui',
            padding: '1px 4px',
            borderRadius: 3,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The dashboard canvas: mount this on a route of your web app (inside your `ZyroxProvider`) and
 * set that URL as the project's preview URL. The dashboard renders drafts here with your real
 * components; clicking a node selects it in the editor.
 */
export function ZyroxPreviewHost({ allowedOrigins, placeholder }: ZyroxPreviewHostProps): ReactNode {
  const stable = useZyrox();
  const [message, setMessage] = useState<PreviewHostMessage | null>(null);
  const [rects, setRects] = useState<{ selected: DOMRect | null; hover: DOMRect | null }>({
    selected: null,
    hover: null,
  });
  const [hovered, setHovered] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const parentOrigin = useRef<string | null>(null);

  // Until a dashboard has spoken, offer `ready` only to allowed origins (others never see it).
  const post = (data: PreviewFrameMessage) => {
    if (parentOrigin.current) window.parent?.postMessage(data, parentOrigin.current);
    else for (const origin of allowedOrigins) window.parent?.postMessage(data, origin);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || !allowedOrigins.includes(event.origin)) return;
      const data = event.data as PreviewHostMessage | undefined;
      if (data?.type !== 'zyrox:render') return;
      parentOrigin.current = event.origin;
      setMessage(data);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'zyrox:ready', manifest: stable.registry.manifest });
    return () => window.removeEventListener('message', onMessage);
  }, [allowedOrigins, stable.registry]);

  const mode = message?.mode ?? 'select';
  const selected = message?.selected ?? null;

  // Keep highlight boxes in sync with layout.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const el = root.current;
      if (el) {
        const next = {
          selected: selected ? nodeRect(el, selected) : null,
          hover: hovered && hovered !== selected ? nodeRect(el, hovered) : null,
        };
        setRects((prev) =>
          sameRect(prev.selected, next.selected) && sameRect(prev.hover, next.hover) ? prev : next,
        );
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [selected, hovered]);

  const previewStable = useMemo(
    () => ({ ...stable, inspect: true, mock: message?.mock ?? true }),
    [stable, message?.mock],
  );

  const nodeFromEvent = (target: EventTarget | null) =>
    (target instanceof Element
      ? target.closest('[data-zyrox-node]')?.getAttribute('data-zyrox-node')
      : null) ?? null;

  if (!message) return placeholder ?? null;
  return (
    // An editor surface: clicks select nodes; keyboard selection happens in the dashboard outline.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    // biome-ignore lint/a11y/useKeyWithMouseEvents: see above
    <div
      ref={root}
      onClickCapture={(e) => {
        if (mode !== 'select') return;
        const nodeId = nodeFromEvent(e.target);
        e.preventDefault();
        e.stopPropagation();
        if (nodeId) post({ type: 'zyrox:select', nodeId });
      }}
      onMouseOver={(e) => setHovered(mode === 'select' ? nodeFromEvent(e.target) : null)}
      onMouseLeave={() => setHovered(null)}
      style={{ minHeight: '100%' }}
    >
      <StableContext.Provider value={previewStable}>
        <ZyroxScreen
          key={message.document.key}
          document={message.document}
          live
          onEvent={(event) => post({ type: 'zyrox:event', event: JSON.parse(JSON.stringify(event)) })}
        />
      </StableContext.Provider>
      <Highlight rect={rects.hover} color="#94a3b8" />
      <Highlight rect={rects.selected} color="#4f46e5" label={selected ?? undefined} />
    </div>
  );
}
