# Contributing

## Setup

```bash
git clone https://github.com/epdlr/slack-stdio-mcp.git
cd slack-stdio-mcp
npm install
npm test
npm run check
```

## Guidelines

- Prefer small, focused PRs.
- **stdout** is MCP protocol only; operator logs go to **stderr**.
- Token policy: `src/token.mjs`, `src/refresh.mjs`, `src/ensure-token.mjs` —
  keep `fetch` injectable for tests.
- User OAuth scopes: edit only `USER_SCOPES` in `src/oauth-flow.mjs`, then update
  the README Own-app table so `npm test` stays green.
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

## Security

See [SECURITY.md](./SECURITY.md). Never commit tokens or `.env` files.

## Releasing (maintainers)

1. Bump `version` in `package.json` and update [CHANGELOG.md](./CHANGELOG.md).
2. Merge to `main`; ensure CI is green.
3. **First release only:** from a clean tree, `npm login` then `npm publish`.
   On npmjs.com → package settings → **Trusted Publisher** (GitHub Actions):
   - User: `epdlr`
   - Repository: `slack-stdio-mcp`
   - Workflow: `publish.yml`
4. **Later releases:** tag matching `package.json` version and push:

```bash
git tag v1.0.1
git push origin v1.0.1
```

`.github/workflows/publish.yml` publishes via OIDC (no long-lived `NPM_TOKEN`).
Do not commit tokens or an auth `.npmrc`.
