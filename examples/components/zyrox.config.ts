import { defineConfig } from '@zyrox/cli';
import { exampleManifestInput } from './src/manifest';

// `pnpm zyrox push --publish --release dev` uploads the example documents to your Zyrox server.
export default defineConfig({
  server: process.env.ZYROX_SERVER ?? 'http://localhost:4400',
  project: process.env.ZYROX_PROJECT ?? 'demo',
  manifest: exampleManifestInput,
  documents: './documents',
});
