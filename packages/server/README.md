# @wishyor/zyrox-server

The Zyrox server provides the delivery API, dashboard API, document publishing, environments, releases, preview relay, webhooks, and MCP endpoint.

## Requirements

- Node.js 22 or later
- PostgreSQL for persistent deployments; PGlite is available for local development
- A stable `ZYROX_SECRET_KEY` in production

Run the server with `zyrox-server` after configuring the database and server environment. For Docker, PostgreSQL, backups, reverse proxies, security, and configuration, see the [self-hosting guide](https://github.com/sanghanihimanshu/Zyrox/blob/main/docs/self-hosting.md).

The first account on a fresh server becomes the owner. After signing in, create a project and invite teammates from its dashboard settings. App SDKs use environment public keys; dashboard and CLI access use user sessions or personal access tokens.