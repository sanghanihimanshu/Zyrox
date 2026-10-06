# Package releases

The packages under `packages/` are published to npm together from a GitHub Release. Package versions must match the release tag; for example, packages at `0.1.0` are released with the tag `v0.1.0`.

## Configure GitHub

Add an Actions repository secret named `NPM_TOKEN` with permission to publish the Zyrox packages to npm. The workflow uses this token only for the publish step.

## Release

1. Update the version in every publishable `packages/*/package.json` to the same new version and commit the changes to `main`.
2. Create and publish a GitHub Release using the matching `v<version>` tag.
3. The `Publish packages` workflow installs from the frozen pnpm lockfile, verifies the tag against package versions, runs lint/typecheck/tests/size checks, builds packages that define a build script, installs Chromium with its system dependencies, runs dashboard e2e tests, then publishes the workspace packages in dependency order.

Packages marked `private` are skipped by pnpm. New public packages should declare their files, exports, dependencies, and build scripts in `package.json`. The workflow deliberately fails on a tag/version mismatch instead of publishing a mixed release.