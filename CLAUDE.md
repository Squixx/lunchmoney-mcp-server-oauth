# lunchmoney-mcp-server-oauth

Self-hostable remote MCP server for Lunch Money with built-in OAuth 2.1.

## Version bump requirement

**Any PR that touches a "versioned path" must bump `package.json` version if the current version is already released (i.e. has a `v{version}` git tag).**

Versioned paths (defined in `.github/workflows/image.yml` as `$VERSIONED_PATHS`):
- `server.mjs`
- `oauth.mjs`
- `sanitize.mjs`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`

The `audit` CI job enforces this: if any versioned path changed and `git ls-remote --tags origin v{version}` exits 0, it fails with:
> image-affecting files changed but version X is already released — bump the version in package.json

**Always bump `package.json` version (patch increment) when modifying any of those files.** Check if the current version tag exists before pushing: `git ls-remote --tags origin v$(node -p "require('./package.json').version")`.

## Dependency overrides

Transitive vulnerability fixes go in `pnpm-workspace.yaml` under `overrides:` — **not** in `package.json`. The `pnpm` field in `package.json` is ignored by pnpm v11+.

CI runs `pnpm audit --prod --audit-level=moderate`. Any moderate+ advisory in prod deps blocks merging.

## CI jobs

- **changes** — detects if image-affecting files changed (superset of versioned paths, adds `Dockerfile`, `.dockerignore`, `.github/workflows/image.yml`)
- **audit** — version-bump guard + `pnpm install --frozen-lockfile --prod` + syntax check + unit tests + smoke test + `pnpm audit`
- **build** — Docker multi-arch build (only runs when `changes` says image changed); pushes on merge to main, build-only on PRs
- **release** — creates a GitHub release + image digest checksums; runs on push to main only

## Dev commands

```sh
pnpm install            # install deps
pnpm audit --prod --audit-level=moderate  # what CI runs
node smoke-test.mjs     # OAuth + MCP integration test
node sanitize.test.mjs  # unit tests
```
