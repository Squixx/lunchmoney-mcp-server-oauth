# Contributing

Thanks for your interest — contributions are welcome, whether that's a bug
report, a docs fix, or a pull request.

## Ground rules

This is a small, security-sensitive project (it gates access to people's
financial data), so changes are held to a few principles:

- **Self-contained.** No new runtime services or upward path dependencies —
  the whole point is that this drops into a `docker compose` file behind a
  proxy.
- **Keep the security posture.** OAuth 2.1 with mandatory PKCE, stateless
  signed tokens, distroless read-only runtime, frozen lockfile. If a change
  weakens any of these, it needs a clear justification.
- **Stay honest.** The README's *Security model & limitations* section is a
  feature. If a change alters the threat model, update it in the same PR.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test    # full OAuth dance + authenticated MCP initialize/tools/list
```

`pnpm test` boots a throwaway server on a local port with dummy credentials
and exercises the whole flow — it makes no calls to the Lunch Money API, so
you don't need a real token to run it.

To run the server against your real account locally:

```sh
LUNCHMONEY_API_TOKEN=<token> MCP_AUTH_TOKEN=$(openssl rand -base64 48) \
  BASE_URL=http://localhost:3000 pnpm start
```

## Pull requests

1. Fork and branch off `main`.
2. Make your change; run `pnpm test` and `node --check server.mjs oauth.mjs`.
3. Open a PR. CI runs the smoke test and `pnpm audit` on every PR, plus a
   multi-arch image build when the PR touches something that ships in the
   image (sources, `package.json`, the lockfile, `pnpm-workspace.yaml`,
   `Dockerfile`, `.dockerignore`, the build workflow) — all must pass. A
   docs-only PR skips the build, and merging it publishes nothing.
4. **You don't need to bump the version.** Renovate handles dependency and
   image bumps (and the version bump that goes with them). For a hand-written
   change that alters image contents, CI will tell you if a `package.json`
   version bump is required.

## Dependency updates

Two cooldowns guard dependency bumps, and they have to be read together:

- `renovate.json` — `minimumReleaseAge: "3 days"` (1 day for security
  updates) decides when Renovate is allowed to *open* a PR.
- `pnpm-workspace.yaml` — `minimumReleaseAge: 1440` decides when pnpm is
  allowed to *resolve* a version. It also re-checks every entry of the
  committed lockfile on `pnpm install --frozen-lockfile`, which is what CI
  runs.

pnpm's window is the floor. Renovate resolves the lockfile with the same
settings, so opening an npm PR before that window elapses gets you a
`package.json` bump with no matching lockfile — Renovate posts an *Artifact
update problem* comment and CI fails with `ERR_PNPM_OUTDATED_LOCKFILE`. The
usual way to end up there is ticking a **Pending Status Checks** box on the
Dependency Dashboard, which skips Renovate's cooldown but not pnpm's.

If you hit it, the fix is to wait out pnpm's day and let Renovate retry, or
to generate the lockfile yourself once the version has matured:

```sh
pnpm install --lockfile-only
```

Do not commit a lockfile produced with the policy disabled
(`--config.minimumReleaseAge=0`): CI verifies the lockfile against the
policy independently and will reject it anyway.

## Reporting security issues

If you find a vulnerability, please open a
[security advisory](https://github.com/Squixx/lunchmoney-mcp-server-oauth/security/advisories/new)
rather than a public issue, so it can be fixed before disclosure.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
