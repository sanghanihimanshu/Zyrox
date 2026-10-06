import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const server = process.env.ZYROX_SERVER ?? 'http://localhost:4400';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: server, ws: true, changeOrigin: true },
      '/v1': { target: server, ws: true, changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        preview: resolve(import.meta.dirname, 'preview.html'),
      },
    },
  },
  test: { include: ['test/**/*.test.{ts,tsx}'], environment: 'jsdom' },
});
