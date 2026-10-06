# CLI guide

Install `@zyrox/cli` in the app repository that contains your component definitions and JSON documents:

```bash
pnpm add -D @zyrox/cli
pnpm exec zyrox --help
```

The CLI loads `zyrox.config.ts`, `.mts`, `.js` or `.mjs` from the current directory. Pass `--config <file>` to select another config. Config-relative document paths are resolved from the config file's directory.

## Configure a project

```ts
import { defineConfig } from '@zyrox/cli';
import { componentDefs, actionDefs, helperNames } from './src/zyrox/defs';

export default defineConfig({
  server: process.env.ZYROX_SERVER,
  project: process.env.ZYROX_PROJECT,
  manifest: { components: componentDefs, actions: actionDefs, helpers: helperNames },
  documents: './zyrox',
});
```

`manifest` may be a `ManifestInput` or a built manifest. Keep its component/action definitions in sync with the app registry; ideally import one shared manifest input from both. The config contains no credentials.

## Authenticate

Create a project-scoped personal access token in the dashboard under **Settings → Access tokens**. Publisher role can upload manifests, update drafts, publish and release. Store it locally:

```bash
pnpm exec zyrox login --token zyx_...
pnpm exec zyrox whoami
```

`login` verifies the token and saves it per server in `~/.config/zyrox/credentials.json` with mode `0600`. Set `ZYROX_CONFIG_DIR` to relocate that file. For CI, set `ZYROX_TOKEN` as a secret; it overrides the locally stored token. `ZYROX_SERVER` and `ZYROX_PROJECT` also override values from the config.

## Commands

Run `pnpm exec zyrox <command> --help` for command-specific options.

| Command | Purpose |
| --- | --- |
| `zyrox whoami` | Verify authentication and list accessible projects |
| `zyrox manifest build [--out file]` | Build the configured manifest locally |
| `zyrox manifest push [--label version]` | Upload this app build's supported components/actions |
| `zyrox pull [--dir folder]` | Download project drafts as JSON files |
| `zyrox push [--dir folder]` | Upload local JSON files as drafts |
| `zyrox push --publish --release dev,staging` | Upload, publish, and release non-block documents |
| `zyrox validate [files...]` | Validate local documents; no server required |
| `zyrox export [--versions] [--out file]` | Export project configuration and documents |
| `zyrox import file [--overwrite]` | Import an export into the current project |
| `zyrox preview-token [--minutes n] [--documents a,b]` | Create a short-lived token for draft previews |
| `zyrox snapshot --public-key pk_... [--out file]` | Download an offline snapshot for an app build |
| `zyrox scaffold component Name` | Generate a component definition and web/native starters |
| `zyrox skills install` / `zyrox skills rules` / `zyrox mcp` | Configure coding-agent support |

The default document directory is `./zyrox`. JSON files are keyed by their relative path: `zyrox/sections/hero.json` becomes document key `sections/hero`. `push` compares against the current draft and skips unchanged content. Add `--message` to record a publish message. Use `--release dev,staging` to target environments; omit it to create versions without changing releases.

Blocks should be published before the screens that use them. The CLI does not release blocks directly; publish a consuming screen to update what an environment delivers.

## CI example

Store the project-scoped token as a repository secret named `ZYROX_TOKEN`:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
      cache: pnpm
  - run: pnpm install --frozen-lockfile
  - run: pnpm exec zyrox validate
  - run: pnpm exec zyrox manifest push --label "$GITHUB_SHA"
    env:
      ZYROX_SERVER: ${{ vars.ZYROX_SERVER }}
      ZYROX_PROJECT: ${{ vars.ZYROX_PROJECT }}
      ZYROX_TOKEN: ${{ secrets.ZYROX_TOKEN }}
```

Only upload the manifest after the app build supports the definitions it contains. To publish documents from CI, add `pnpm exec zyrox push --publish --release dev` with a publisher token; use protected environments/secrets for production releases.

For first-time project setup, see [Getting started](getting-started.md). For npm package releases, see [Package releases](releasing.md).