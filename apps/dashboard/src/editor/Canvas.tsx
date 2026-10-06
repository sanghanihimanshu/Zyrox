import type { Document, Manifest } from '@wishyor/zyrox-protocol';
import type { PreviewFrameMessage, PreviewHostMessage } from '@wishyor/zyrox-react/preview';
import { Monitor, MousePointer2, RotateCw, Smartphone, Tablet, TestTube2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx, IconButton } from '../ui';

const DEVICES = {
  phone: { width: 390, height: 844, icon: Smartphone, label: 'Phone' },
  tablet: { width: 820, height: 1180, icon: Tablet, label: 'Tablet' },
  desktop: { width: 1280, height: 800, icon: Monitor, label: 'Desktop' },
} as const;
type DeviceKey = keyof typeof DEVICES;

export interface CanvasProps {
  document: Document;
  selected: string | null;
  /** The project's own preview route; when empty, the built-in placeholder preview is used. */
  previewUrl: string | null;
  projectSlug: string;
  onSelect(id: string): void;
  onEvent(event: unknown): void;
  onManifest?(manifest: Manifest): void;
}

/** The editor canvas: an iframe running a preview host, driven over `postMessage`. */
export function Canvas({
  document,
  selected,
  previewUrl,
  projectSlug,
  onSelect,
  onEvent,
  onManifest,
}: CanvasProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [device, setDevice] = useState<DeviceKey>('phone');
  const [mode, setMode] = useState<'select' | 'interact'>('select');
  const [mock, setMock] = useState(true);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const src = previewUrl || `/preview.html?project=${encodeURIComponent(projectSlug)}`;
  const targetOrigin = previewUrl ? new URL(previewUrl, location.href).origin : location.origin;
  const latest = useRef({ document, selected, mode, mock });
  latest.current = { document, selected, mode, mock };
  const handlers = useRef({ onSelect, onEvent, onManifest });
  handlers.current = { onSelect, onEvent, onManifest };

  const send = () => {
    const { document: doc, selected: sel, mode: m, mock: k } = latest.current;
    const message: PreviewHostMessage = {
      type: 'zyrox:render',
      document: doc,
      selected: sel,
      mode: m,
      mock: k,
    };
    frame.current?.contentWindow?.postMessage(message, targetOrigin);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: send and handlers read refs
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as PreviewFrameMessage;
      if (data?.type === 'zyrox:ready') {
        setReady(true);
        if (previewUrl) handlers.current.onManifest?.(data.manifest);
        send();
      } else if (data?.type === 'zyrox:select') handlers.current.onSelect(data.nodeId);
      else if (data?.type === 'zyrox:event') handlers.current.onEvent(data.event);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewUrl]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-send whenever what the frame shows changes
  useEffect(() => {
    if (ready) send();
  }, [ready, document, selected, mode, mock]);

  // Fit the device into the available space.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const fitDevice = () => {
      const { width, height } = DEVICES[device];
      const s = Math.min(1, (el.clientWidth - 32) / width, (el.clientHeight - 32) / height);
      setScale(Math.max(0.2, s));
    };
    fitDevice();
    const observer = new ResizeObserver(fitDevice);
    observer.observe(el);
    return () => observer.disconnect();
  }, [device]);

  const { width, height } = DEVICES[device];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-zinc-200 bg-white px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900">
        {(Object.keys(DEVICES) as DeviceKey[]).map((key) => {
          const Icon = DEVICES[key].icon;
          return (
            <IconButton
              key={key}
              label={DEVICES[key].label}
              aria-pressed={device === key}
              className={cx(
                device === key && 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
              )}
              icon={<Icon className="size-4" />}
              onClick={() => setDevice(key)}
            />
          );
        })}
        <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
        <IconButton
          label={mode === 'select' ? 'Selecting (click to interact)' : 'Interacting (click to select)'}
          aria-pressed={mode === 'interact'}
          className={cx(
            mode === 'interact' && 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
          )}
          icon={<MousePointer2 className="size-4" />}
          onClick={() => setMode(mode === 'select' ? 'interact' : 'select')}
        />
        <IconButton
          label={mock ? 'Using mock data (click for live data)' : 'Using live data (click for mocks)'}
          aria-pressed={mock}
          className={cx(mock && 'bg-zinc-100 dark:bg-zinc-800')}
          icon={<TestTube2 className="size-4" />}
          onClick={() => setMock(!mock)}
        />
        <IconButton
          label="Reload preview"
          icon={<RotateCw className="size-4" />}
          onClick={() => {
            setReady(false);
            setReloadKey((k) => k + 1);
          }}
        />
        <span className="ml-auto truncate text-[11px] text-zinc-400">
          {mode === 'interact' ? 'Interact mode: taps run actions' : 'Click a component to select it'} ·{' '}
          {previewUrl ? 'your app' : 'placeholder preview'} · {Math.round(scale * 100)}%
        </span>
      </div>
      <div
        ref={area}
        className="relative min-h-0 flex-1 overflow-hidden bg-zinc-100 bg-[radial-gradient(circle,_rgb(0_0_0/0.06)_1px,_transparent_1px)] [background-size:16px_16px] dark:bg-zinc-950"
      >
        <div
          className="absolute top-4 left-1/2 overflow-hidden rounded-[28px] bg-white shadow-xl ring-1 ring-zinc-300 dark:ring-zinc-700"
          style={{
            width,
            height,
            transform: `translateX(-50%) scale(${scale})`,
            transformOrigin: 'top center',
          }}
        >
          <iframe key={reloadKey} ref={frame} src={src} title="Preview" className="size-full border-0" />
        </div>
      </div>
    </div>
  );
}
