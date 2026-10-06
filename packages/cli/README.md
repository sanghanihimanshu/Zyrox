# @zyrox/cli

The Zyrox CLI uploads app manifests, syncs screens and blocks as JSON, validates documents, publishes versions, creates offline snapshots, and configures coding-agent tooling.

## Install

```bash
pnpm add -D @zyrox/cli
pnpm exec zyrox --help
```

Create a `zyrox.config.ts` in your app repository:

```ts
import { defineConfig } from '@zyrox/cli';
import { componentDefs, actionDefs } from './src/zyrox/defs';

export default defineConfig({
  server: process.env.ZYROX_SERVER,
  project: process.env.ZYROX_PROJECT,
  manifest: { components: componentDefs, actions: actionDefs },
  documents: './zyrox',
});
```

Create a project-scoped token in the dashboard under **Settings → Access tokens**, then authenticate:

```bash
pnpm exec zyrox login --token zyx_...
pnpm exec zyrox manifest push --label 1.0.0
pnpm exec zyrox pull
pnpm exec zyrox validate
pnpm exec zyrox push --publish --release dev
```

Use a publisher token for publishing/releasing. For CI, set `ZYROX_TOKEN`, `ZYROX_SERVER`, and `ZYROX_PROJECT` as environment variables instead of storing credentials in the repository.

See the [CLI guide](https://github.com/sanghanihimanshu/Zyrox/blob/main/docs/cli.md) for command reference and CI setup, and [Getting started](https://github.com/sanghanihimanshu/Zyrox/blob/main/docs/getting-started.md) for the full project setup.