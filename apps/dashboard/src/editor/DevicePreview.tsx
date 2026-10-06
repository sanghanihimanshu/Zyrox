import { useMutation } from '@tanstack/react-query';
import type { Document } from '@wishyor/zyrox-protocol';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import { post } from '../lib/api';
import { Badge, Button, Dialog, errorMessage, Field, Input } from '../ui';

interface Session {
  id: string;
  token: string;
}

/**
 * Live preview on real devices: a QR code with a deep link to the draft. Edits stream to every
 * connected device over a WebSocket; their runtime events come back to the console.
 */
export function DevicePreview({
  open,
  onClose,
  projectSlug,
  document,
  previewUrl,
  onEvent,
}: {
  open: boolean;
  onClose(): void;
  projectSlug: string;
  document: Document;
  previewUrl: string | null;
  onEvent(event: unknown, device?: string): void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [devices, setDevices] = useState<{ platform?: string }[]>([]);
  const [scheme, setScheme] = useState(() => localStorage.getItem('zyrox:scheme') ?? 'zyroxexample');
  const socket = useRef<WebSocket | null>(null);
  const latestDoc = useRef(document);
  latestDoc.current = document;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const start = useMutation({
    mutationFn: () => post<Session>(`/projects/${projectSlug}/preview-sessions`),
    onSuccess: setSession,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: start once per open
  useEffect(() => {
    if (open && !session && !start.isPending) start.mutate();
  }, [open, session]);

  useEffect(() => {
    if (!session) return;
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/preview/${session.id}/ws`);
    socket.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'document', document: latestDoc.current, mock: true }));
    ws.onmessage = (m) => {
      const data = JSON.parse(String(m.data)) as {
        type: string;
        devices?: { platform?: string }[];
        event?: unknown;
        device?: { platform?: string };
      };
      if (data.type === 'devices') setDevices(data.devices ?? []);
      if (data.type === 'event') onEventRef.current(data.event, data.device?.platform);
    };
    return () => {
      socket.current = null;
      ws.close();
    };
  }, [session]);

  // Stream every edit while the session lives (even when the dialog is closed).
  useEffect(() => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'document', document, mock: true }));
  }, [document]);

  const query = session
    ? `server=${encodeURIComponent(location.origin)}&session=${session.id}&token=${session.token}`
    : '';
  const appLink = `${scheme}://zyrox-preview?${query}`;
  const webLink = previewUrl
    ? `${new URL(previewUrl, location.href).origin}/?zyrox-preview=1&${query}`
    : null;
  return (
    <Dialog open={open} onClose={onClose} title="Preview on a device">
      {start.error ? <p className="text-sm text-red-600">{errorMessage(start.error)}</p> : null}
      {session ? (
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG value={appLink} size={200} />
          </div>
          <p className="text-center text-sm text-zinc-500">
            Scan with your phone. Your app opens the link with{' '}
            <code className="font-mono">parsePreviewLink</code> and shows{' '}
            <code className="font-mono">{'<ZyroxLivePreview />'}</code>. Edits appear instantly.
          </p>
          <div className="flex items-center gap-2 text-sm">
            Connected:{' '}
            {devices.length ? (
              <Badge tone="green">
                {devices.length} · {devices.map((d) => d.platform ?? 'device').join(', ')}
              </Badge>
            ) : (
              <Badge>none yet</Badge>
            )}
          </div>
          <Field label="Your app's URL scheme">
            <Input
              value={scheme}
              onChange={(e) => {
                setScheme(e.target.value);
                localStorage.setItem('zyrox:scheme', e.target.value);
              }}
              className="font-mono"
            />
          </Field>
          <div className="flex w-full flex-col gap-1 text-xs">
            <code className="truncate rounded bg-zinc-100 p-2 font-mono dark:bg-zinc-800" title={appLink}>
              {appLink}
            </code>
            {webLink ? (
              <a className="text-indigo-600 hover:underline" href={webLink} target="_blank" rel="noreferrer">
                Open in your web app
              </a>
            ) : null}
          </div>
          <Button size="sm" onClick={() => void navigator.clipboard?.writeText(appLink)}>
            Copy link
          </Button>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">Starting a preview session…</p>
      )}
    </Dialog>
  );
}
