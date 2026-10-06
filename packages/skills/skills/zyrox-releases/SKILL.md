---
name: zyrox-releases
description: Publish and release Zyrox server-driven screens safely - publish/validation and the app-build compatibility report, environments (dev/staging/prod), targeting rules (platform, app version, attributes, user, locale), percentage rollouts, A/B experiments with exposure events, rollback, promotion, health monitoring and the audit log. Use when shipping a screen change, setting up a gradual rollout or experiment, rolling back, or checking error rates after a release.
---

# Releasing with Zyrox

## Publish

Publishing turns the draft into an **immutable version** (content-addressed, cached forever by apps and CDNs). It validates structure, expressions and every component/prop/action against the latest app manifest, inlines blocks, and lists **older app builds still in use that can't render it** (with traffic share). Fix errors; for compatibility warnings add `fallback`s or target newer builds with a rule.

Dashboard: Publish → message → release to environments. CLI: `zyrox push --publish --release dev`.

## Environments

`dev`, `staging`, `prod`, each with a public key for the app. Promote everything: Releases → Promote (`staging → prod`). Apps pick up changes on their next bootstrap (environment TTL, default 60 s, plus app foreground).

## Targeting rules

Each released document has a default version plus ordered rules; the first matching rule wins.

| Goal | When |
|---|---|
| iOS only | `client.platform == 'ios'` |
| New app builds | `semver(client.app, '>=3.4.0')` |
| A market | `attrs.country == 'IN'` |
| Paying users | `attrs.plan == 'pro'` |
| Internal testers | `includes(['u_1', 'u_2'], user.id)` |
| French speakers | `includes(locale, 'fr')` |

Scope: `client.platform`, `client.app`, `client.manifest`, `attrs.*` (provider `attrs`), `user.id` (provider `user` or install id), `locale`.

**Rollout %** on a rule serves it to a stable share of matching users (bucketed by user id): 5 → 25 → 100.

## Experiments

1. Publish two versions. 2. Experiments → New (variants → versions, weights). 3. Start it. 4. Releases → Edit → add a rule that serves the experiment.
Assignment is sticky per user. Apps emit `exposure` events (experiment, variant) to your observers → analyze in your analytics tool; the dashboard shows exposure counts.

## Monitor and roll back

- Health shows views, error rate per version, top errors (kind, node, message), functions and app-build adoption.
- Roll back (Releases → Roll back) points the environment to the previous version and clears its rules - instant on the next bootstrap.
- Every publish, release, rollback, promotion and membership change is in Settings → Audit log.

## Automate around releases

- **Webhooks** (Settings → Webhooks): signed POSTs for `document.publish`, `release.*` (set, rollback, promote, remove), `experiment.*`… Rebuild a site, purge a CDN, notify a channel. Verify with `verifySignature` from `@wishyor/zyrox-server`; ignore repeated `x-zyrox-delivery` ids (retries).
- **API**: `/api/v1` with a personal access token (scope it to one project and role for CI); OpenAPI at `/api/v1/openapi.json`.
- **Review builds**: `zyrox preview-token` → `<ZyroxProvider previewToken>` shows drafts in a real app build; `fetchScreen({ previewToken })` for SSR draft mode.
- **Move projects**: `zyrox export --versions` / `zyrox import <file>` (staging server → production, templates). Details: `docs/headless.md` in the Zyrox repository.

## Safe release checklist

- [ ] Problems panel clean; compatibility warnings handled
- [ ] Tried in the canvas and on a device (Device → QR)
- [ ] Released to `dev`, then `staging`, then `prod` with a rollout rule
- [ ] Watched Health error rate before going to 100%
