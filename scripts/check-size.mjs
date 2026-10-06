import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const entry = 'virtual:zyrox-runtime-size';
const budgetBytes = 35 * 1024;

const result = await build({
  configFile: false,
  root,
  logLevel: 'silent',
  plugins: [
    {
      name: 'zyrox-runtime-size-entry',
      enforce: 'pre',
      resolveId(id) {
        return id === entry ? '\0zyrox-runtime-size-entry' : undefined;
      },
      load(id) {
        if (id !== '\0zyrox-runtime-size-entry') return undefined;
        const source = resolve(root, 'packages/react/src/index.ts');
        return (
          `import { ZyroxProvider, ZyroxScreen, createRegistry, implement } from ${JSON.stringify(source)};\n` +
          'globalThis.__zyroxSizeProbe = [ZyroxProvider, ZyroxScreen, createRegistry, implement];'
        );
      },
    },
  ],
  build: {
    write: false,
    minify: 'esbuild',
    rollupOptions: {
      input: entry,
      external: (id) => id === 'react' || id.startsWith('react/'),
    },
  },
});

const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
const chunks = outputs.filter((output) => output.type === 'chunk');
if (!chunks.length) throw new Error('The runtime size build produced no JavaScript chunks');
const gzipBytes = chunks.reduce((total, chunk) => total + gzipSync(chunk.code).byteLength, 0);

console.log(
  `React runtime: ${(gzipBytes / 1024).toFixed(2)} KiB gzipped (budget: ${(budgetBytes / 1024).toFixed(0)} KiB)`,
);
if (gzipBytes > budgetBytes) {
  console.error('The runtime exceeds its gzipped size budget.');
  process.exitCode = 1;
}
