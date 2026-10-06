import { type Fetcher, ZyroxProvider, ZyroxScreen } from '@wishyor/zyrox-react';
import { defaultOverlays } from '@wishyor/zyrox-react/overlays';
import { parsePreviewLink, ZyroxLivePreview, ZyroxPreviewHost } from '@wishyor/zyrox-react/preview';
import { createExampleRegistry, exampleStrings } from '@zyrox-examples/components';
import { documents } from '@zyrox-examples/components/documents';
import { handleShopRequest } from '@zyrox-examples/shop-api';
import './app.css';

const registry = createExampleRegistry();
const previewLink = parsePreviewLink(window.location.href);
const dashboardOrigins = (import.meta.env.VITE_ZYROX_DASHBOARD_ORIGINS ?? window.location.origin)
  .split(',')
  .map((origin: string) => origin.trim())
  .filter(Boolean);

const fetcher: Fetcher = (request) =>
  handleShopRequest({ method: request.method, url: request.url, body: request.body });

export function App() {
  return (
    <ZyroxProvider
      registry={registry}
      endpoint={import.meta.env.VITE_ZYROX_ENDPOINT}
      publicKey={import.meta.env.VITE_ZYROX_KEY}
      appVersion="1.0.0"
      documents={documents}
      fetcher={fetcher}
      strings={exampleStrings}
      defaultLocale="en"
      overlays={defaultOverlays}
      mock
    >
      {window.location.pathname === '/__zyrox/preview' ? (
        <ZyroxPreviewHost allowedOrigins={dashboardOrigins} />
      ) : previewLink ? (
        <ZyroxLivePreview {...previewLink} loading={<p>Connecting to the dashboard preview…</p>} />
      ) : (
        <main className="shop-shell">
          <header className="shop-header">
            <a href="/" aria-label="Zyrox shop home">
              Zyrox shop
            </a>
            <span>Live example</span>
          </header>
          <ZyroxScreen
            screen="shop-home"
            loading={<p className="shop-loading">Loading shop…</p>}
            fallback={<p className="shop-loading">Shop screen unavailable.</p>}
          />
        </main>
      )}
    </ZyroxProvider>
  );
}
