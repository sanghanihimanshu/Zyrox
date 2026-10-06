import type { Manifest } from '@zyrox/protocol';
import { ZyroxProvider } from '@zyrox/react';
import { ZyroxPreviewHost } from '@zyrox/react/preview';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { placeholderRegistry } from './placeholders';

const project = new URLSearchParams(location.search).get('project') ?? '';

function PreviewApp() {
  const [manifest, setManifest] = useState<Manifest | null | undefined>(undefined);
  useEffect(() => {
    fetch(`/api/projects/${encodeURIComponent(project)}/manifests`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { manifests: [] }))
      .then((data: { manifests: { latest: boolean; manifest: Manifest }[] }) =>
        setManifest(data.manifests.find((m) => m.latest)?.manifest ?? null),
      )
      .catch(() => setManifest(null));
  }, []);
  const registry = useMemo(
    () => (manifest === undefined ? null : placeholderRegistry(manifest ?? undefined)),
    [manifest],
  );
  if (!registry) return null;
  return (
    <ZyroxProvider
      registry={registry}
      navigate={(to) => console.info('[preview] navigate', to)}
      back={() => console.info('[preview] back')}
      openUrl={(url) => console.info('[preview] openUrl', url)}
      fetcher={async () => ({})}
      callFunction={async () => null}
    >
      <ZyroxPreviewHost
        allowedOrigins={[location.origin]}
        placeholder={
          <p style={{ padding: 16, color: '#9ca3af', font: '13px system-ui' }}>Waiting for the editor…</p>
        }
      />
    </ZyroxProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreviewApp />
  </StrictMode>,
);
