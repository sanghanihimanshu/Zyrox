# Getting started

This guide connects a React or React Native app to a Zyrox server and creates the first editable screen. For server installation, start with [Self-hosting](self-hosting.md); for the full renderer API, see the [Library guide](library.md).

## 1. Start a Zyrox server

Use your hosted server URL or run the server locally. The local development command is:

```bash
pnpm install
pnpm --filter @wishyor/zyrox-dashboard build
pnpm --filter @wishyor/zyrox-server start
```

The local server listens at `http://localhost:4400`. The first account created in a fresh instance becomes the owner. Keep the database volume and server secret key persistent in deployments.

## 2. Create a project

Sign in to the dashboard at the server URL, create a project for your app, and note its slug. Each project owns its app manifest, screens, blocks, environments, keys and team roles. The first project has development, staging and production environments.

## 3. Add the runtime and CLI

Install the runtime in the app and the CLI in the repository that owns the component definitions and screen JSON:

```bash
pnpm add @wishyor/zyrox-react
pnpm add -D @wishyor/zyrox-cli
```

For React Native, also install and configure React Native and its platform requirements. The example app and [Library guide](library.md) show the provider and registry setup.

In the dashboard, open **Settings → Environments & keys** and copy the development public key. Configure the app's `ZyroxProvider` with that key and the server URL. Public environment keys belong in the app; never bundle an admin or CLI token.

## 4. Share component definitions with the CLI

The app registry implements components; the CLI manifest contains their definitions. Use the same definition list for both so their manifest hashes match. Create `zyrox.config.ts` at the app repository root:

```ts
import { defineConfig } from '@wishyor/zyrox-cli';
import { componentDefs, actionDefs, helperNames } from './src/zyrox/defs';

export default defineConfig({
  server: process.env.ZYROX_SERVER,
  project: process.env.ZYROX_PROJECT,
  manifest: {
    components: componentDefs,
    actions: actionDefs,
    helpers: helperNames,
  },
  documents: './zyrox',
});
```

Adapt the import paths to your app. Components must be defined with `defineComponent` and registered by your `createRegistry` call; actions use `defineAction`. The [component guide](../packages/skills/skills/zyrox-components/SKILL.md) has a complete example.

## 5. Create a project token and sign in

In the project dashboard, open **Settings → Access tokens** and create a project-scoped token. Use publisher role when the same token will upload manifests, edit drafts, and publish; an editor token can upload manifests and drafts but cannot publish.

Save the token in the CLI credential store:

```bash
pnpm exec zyrox login --token zyx_...
pnpm exec zyrox whoami
```

The CLI stores credentials in `~/.config/zyrox/credentials.json` with owner-only file permissions. In CI, use a secret environment variable instead of the credential store:

```bash
export ZYROX_SERVER=https://ui.example.com
export ZYROX_PROJECT=my-app
export ZYROX_TOKEN="$ZYROX_TOKEN_SECRET"
```

The global `--server`, `--project`, and `--config` options override config/environment values. Never commit tokens or put them in `zyrox.config.ts`.

## 6. Upload the app manifest

Upload the set of components and actions supported by the app build:

```bash
pnpm exec zyrox manifest build
pnpm exec zyrox manifest push --label "$APP_VERSION"
```

The dashboard uses this manifest for component choices, property forms, validation and compatibility warnings. Upload it for every app build that changes supported components or actions.

## 7. Create and publish a screen

Create a screen in **Screens & blocks**, then build it in the visual editor. Or keep JSON documents in the configured `zyrox` folder:

```bash
pnpm exec zyrox pull
pnpm exec zyrox validate
pnpm exec zyrox push
```

`push` uploads drafts only. To publish and release screens to development:

```bash
pnpm exec zyrox push --publish --release dev --message "Initial screen"
```

Publishing validates against the latest manifest and creates an immutable version. Releasing assigns that version to an environment. Blocks are versioned but not released directly; publish a screen that references a block to deliver the block's latest published version. See the [Dashboard guide](dashboard.md) for roles and workflow details.

## Continue

- [CLI guide](cli.md) for all commands and CI recipes.
- [Library guide](library.md) for screens, state, data sources, actions, preview and offline delivery.
- [Self-hosting](self-hosting.md) for production deployment and security.