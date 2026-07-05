# lunchmoney-mcp-server-oauth

Self-hostable **remote MCP server** for [Lunch Money](https://lunchmoney.app)
with a **built-in OAuth 2.1 authorization server** — so it works as a
[claude.ai custom connector](https://claude.com/docs/connectors) on
**Claude mobile, web, and desktop**, as well as Claude Code and any other
Streamable-HTTP MCP client.

Wraps [@akutishevsky/lunchmoney-mcp](https://github.com/akutishevsky/lunchmoney-mcp)
(40+ tools covering transactions, budgets, categories, recurring items,
assets, crypto, tags) and serves it over HTTP.

## Why this exists

If you want Claude on your phone to see your Lunch Money data, your options
were all bad:

| Option | Problem |
|--------|---------|
| stdio MCP servers (most community servers) | Local-only; Claude mobile can't use them |
| HTTP server + static bearer token | claude.ai custom connectors have **no field for a static header** — OAuth is the only supported auth ([anthropics/claude-ai-mcp#112](https://github.com/anthropics/claude-ai-mcp/issues/112)) |
| Hosted MCP platforms | You hand a third party your Lunch Money API token — full read/write access to your finances |
| No auth | Your finances, public |

This server closes the gap: it implements the minimal OAuth 2.1 surface
Claude needs (RFC 8414 + RFC 9728 discovery, RFC 7591 dynamic client
registration, authorization-code grant with mandatory S256 PKCE, rotating
refresh tokens), with a single shared secret as the consent "login". Your
API token never leaves your box.

## How it works

1. You add `https://lm.example.com/mcp` as a custom connector in Claude.
2. Claude discovers the OAuth metadata, registers itself as a client, and
   opens a browser to the consent page.
3. You paste your `MCP_AUTH_TOKEN` (a secret you generated) once.
4. Claude receives access + refresh tokens and keeps them fresh on its own,
   across all your Claude surfaces.

**Stateless by design**: every artifact the server issues — client IDs,
authorization codes, access and refresh tokens — is an HMAC-signed blob
keyed off `MCP_AUTH_TOKEN` via HKDF. There is no database and no session
store, which means:

- container restarts don't log Claude out
- the container runs with a read-only filesystem
- **rotating `MCP_AUTH_TOKEN` instantly revokes every client and token** —
  that's your kill switch

| Artifact | Lifetime |
|----------|----------|
| authorization code | 2 min, single-use |
| access token | 1 hour |
| refresh token | 90 days, rotated on every refresh |

## Quick start

```sh
# 1. Secrets
cp docker-compose.example.yml docker-compose.yml
cat > .env <<EOF
LUNCHMONEY_API_TOKEN=<lunchmoney.app -> Settings -> Developers>
LUNCHMONEY_MCP_TOKEN=$(openssl rand -base64 48)
EOF

# 2. Set BASE_URL in docker-compose.yml to your public https URL, then:
docker compose up -d

# 3. Put a TLS reverse proxy in front (see below), then add the connector
#    in Claude: Settings -> Connectors -> Add custom connector ->
#    https://lm.example.com/mcp
```

The image is multi-arch (amd64/arm64), built on Google's distroless Node 22
(no shell, no package manager, runs as non-root uid 65532), published by
[CI](.github/workflows/image.yml) from this repo:
`ghcr.io/squixx/lunchmoney-mcp`.

## Reverse proxy requirements

The server speaks plain HTTP and **must** sit behind a TLS-terminating
reverse proxy. Recommendations:

- **Forward only what's needed**: `/mcp`, `/authorize`, `/consent`,
  `/token`, `/register`, `/.well-known/oauth-authorization-server*`,
  `/.well-known/oauth-protected-resource*`. 404 everything else at the
  edge.
- **Rate-limit the auth endpoints** hard (e.g. 20 req/min per IP on
  `/register`, `/authorize`, `/consent`, `/token`) and `/mcp` loosely
  (Claude bursts several tool calls per turn — 20 req/s is comfortable).
- Don't strip or rewrite the `Authorization` header.

<details>
<summary>Caddy example</summary>

```caddyfile
lm.example.com {
        @allowed path /mcp /authorize /consent /token /register /.well-known/oauth-authorization-server* /.well-known/oauth-protected-resource*
        handle @allowed {
                reverse_proxy lunchmoney-mcp:3000
        }
        respond "Not Found" 404
}
```

(Add rate limiting with your module of choice, e.g. `mholt/caddy-ratelimit`.)
</details>

## Environment

| Variable               | Required | Default | Notes                                             |
|------------------------|----------|---------|---------------------------------------------------|
| `LUNCHMONEY_API_TOKEN` | yes      | —       | From Lunch Money → Settings → Developers          |
| `MCP_AUTH_TOKEN`       | yes      | —       | OAuth consent password **and** HKDF seed for the token-signing key. Min 32 chars; use `openssl rand -base64 48` |
| `BASE_URL`             | yes      | —       | Public URL the OAuth issuer advertises            |
| `PORT`                 | no       | `3000`  | Listen port                                       |

The process exits non-zero at startup if anything required is missing.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/healthz` | Liveness (unauthenticated, reveals nothing) |
| `GET`  | `/.well-known/oauth-authorization-server[/mcp]` | RFC 8414 metadata |
| `GET`  | `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 metadata |
| `POST` | `/register` | RFC 7591 dynamic client registration |
| `GET`  | `/authorize` | Consent form |
| `POST` | `/consent` | Password check → authorization code |
| `POST` | `/token` | Code exchange (PKCE) + refresh grant |
| `POST` | `/mcp` | MCP JSON-RPC (stateless Streamable HTTP, Bearer auth) |

## Security model & limitations

Honest list — read before exposing your finances to the internet:

- **Single-user, single-secret.** Anyone with `MCP_AUTH_TOKEN` gets full
  read/write access to your Lunch Money account. There are no scopes, no
  per-client permissions, no user accounts. This is a personal server.
- Open dynamic client registration is intentional and spec-conformant:
  registering grants nothing; only the consent password turns a client
  into an authorized one, and client IDs are self-signed blobs (nothing is
  stored, so registration spam costs nothing).
- PKCE S256 is mandatory; redirect URIs must match registration exactly
  and be `https` (or loopback `http` for local dev tools).
- Consent password comparison is constant-time, with a 750 ms delay on
  failure — but your real brute-force defense is the secret's entropy
  (256+ bits) plus edge rate limiting.
- Authorization codes are replay-guarded in memory only: a container
  restart inside a code's 2-minute lifetime would allow one replay.
  Accepted for a single-user server behind TLS.
- The Lunch Money API token sits in the container's environment. Anyone
  with Docker host access owns your data anyway.
- MCP prompt-injection caveat: any tool-using LLM can be manipulated by
  data it reads. Transaction payees/notes are attacker-influenceable
  strings (anyone who sends you a payment names the payee). Claude
  processes those through the same context that can call write tools.
  Consider Lunch Money's data sensitivity before enabling write-heavy
  workflows.

## Versioning & releases

Semver, **independent of the upstream tools package** (encoding the upstream
version in the tag breaks semver tooling — `2.1.0-1` sorts *before* `2.1.0`
as a prerelease, and four segments aren't semver at all):

| Bump | When |
|------|------|
| **major** | Breaking wrapper contract: env var renames, endpoint changes, token-format changes that force reconfiguration |
| **minor** | `@akutishevsky/lunchmoney-mcp` upgrade (the tool surface Claude sees changed), or new wrapper features |
| **patch** | Wrapper fixes and other dependency bumps |

Mechanics:

- The image tag **is** the `package.json` version; CI publishes it and
  creates a matching git tag + GitHub Release on the first build of each
  version.
- Renovate PRs bump the version automatically in the same PR
  (`bumpVersion` in `renovate.json`), so every dependency change publishes
  a new tag that downstream version pins can track.
- CI rejects PRs that change image contents without a version bump.
- The upstream tools version an image carries is exposed as the OCI label
  `app.lunchmoney-mcp.upstream-version` and stated in each release's notes.
- The weekly scheduled rebuild republishes the **same** version with fresh
  base layers (distroless/Alpine security patches) — pull to refresh; no
  release is created.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test          # boots a throwaway server, runs the full OAuth dance
                   # + authenticated MCP initialize/tools/list (no Lunch
                   # Money API calls)
LUNCHMONEY_API_TOKEN=<token> MCP_AUTH_TOKEN=$(openssl rand -base64 48) \
  BASE_URL=http://localhost:3000 pnpm start
```

Supply-chain posture: committed lockfile + `--frozen-lockfile` everywhere,
pnpm `minimumReleaseAge: 1440` (24 h cool-off on new releases), dependency
install scripts disabled, Corepack strict pinning (pnpm pinned by sha512),
`pnpm audit` gating CI, weekly image rebuilds for base-image patches.

## Credits

- [@akutishevsky/lunchmoney-mcp](https://github.com/akutishevsky/lunchmoney-mcp) — the actual MCP tool implementations this wraps
- [Lunch Money](https://lunchmoney.app) — and its [developer API](https://lunchmoney.dev)

MIT — see [LICENSE](LICENSE).
