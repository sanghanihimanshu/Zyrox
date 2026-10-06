import { loader } from '@monaco-editor/react';
// Only the editor core and JSON support: keeps the lazy chunk small (no TypeScript/CSS/HTML workers).
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import { jsonDefaults } from 'monaco-editor/language/json/monaco.contribution';

// Bundle Monaco instead of loading it from a CDN, so the dashboard works offline and self-hosted.
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
};
loader.config({ monaco });

export { jsonDefaults, monaco };
