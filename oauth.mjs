// Self-contained OAuth 2.1 authorization server for lunchmoney-mcp.
//
// Why this exists: claude.ai custom connectors (web + mobile) can only speak
// OAuth — there is no field for a static bearer token or custom header. So
// instead of authenticating at the reverse proxy, this process implements the
// minimal OAuth 2.1 surface Claude needs (RFC 8414 metadata, RFC 9728
// protected-resource metadata, RFC 7591 dynamic client registration,
// authorization-code grant with mandatory S256 PKCE, refresh tokens). The
// "login" at the consent screen is a single shared secret: MCP_AUTH_TOKEN.
//
// Statelessness: this server keeps no client or token database. Every
// artifact it issues (client_id, authorization code, access token, refresh
// token) is an HMAC-signed blob that carries its own claims, keyed off
// MCP_AUTH_TOKEN via HKDF. Consequences:
//   - Restarts do not invalidate sessions (no re-auth after redeploys).
//   - Rotating MCP_AUTH_TOKEN invalidates every client and token at once.
//   - Authorization codes are single-use only per-process (in-memory replay
//     guard); a restart inside the 2-minute code lifetime would allow one
//     replay. Accepted: single-user server behind TLS.

import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import express from "express";

const CODE_TTL_S = 120; // authorization codes: one Claude round-trip
const TXN_TTL_S = 600; // consent form validity: human time scale
const ACCESS_TTL_S = 3600; // access tokens: 1 hour
const REFRESH_TTL_S = 90 * 24 * 3600; // refresh tokens: 90 days (rotated on use)

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (s) => createHash("sha256").update(s).digest();
const now = () => Math.floor(Date.now() / 1000);

// Constant-time equality that doesn't leak length differences: compare
// fixed-size digests instead of the raw strings.
const safeEqual = (a, b) => timingSafeEqual(sha256(a), sha256(b));

export function createOAuth({ baseUrl, authPassword, serviceName }) {
  const issuer = baseUrl.replace(/\/+$/, "");
  const signingKey = Buffer.from(
    hkdfSync("sha256", authPassword, "lunchmoney-mcp-oauth", "signing-key-v1", 32),
  );

  const sign = (payload) => {
    const body = b64url(JSON.stringify(payload));
    const mac = b64url(createHmac("sha256", signingKey).update(body).digest());
    return `${body}.${mac}`;
  };

  // Returns the payload iff signature is valid, `t` matches, and not expired.
  const verify = (token, type) => {
    if (typeof token !== "string" || token.length > 4096) return null;
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const expected = createHmac("sha256", signingKey).update(body).digest();
    let given;
    try {
      given = Buffer.from(mac, "base64url");
    } catch {
      return null;
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (payload.t !== type) return null;
    if (typeof payload.exp === "number" && payload.exp < now()) return null;
    return payload;
  };

  // Replay guard for authorization codes (jti -> expiry). In-memory on
  // purpose — see the statelessness note at the top of this file.
  const usedCodes = new Map();
  const codeSeen = (jti, exp) => {
    for (const [k, e] of usedCodes) if (e < now()) usedCodes.delete(k);
    if (usedCodes.has(jti)) return true;
    usedCodes.set(jti, exp);
    return false;
  };

  const validRedirectUri = (uri) => {
    let u;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    if (u.protocol === "https:") return true;
    // Loopback redirects are allowed for local dev clients (MCP Inspector).
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  };

  const asMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
  const prMetadata = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  };

  const consentPage = ({ txn, error }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${serviceName} — authorize</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: Canvas; color: CanvasText; }
  form { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
         border-radius: 12px; padding: 2rem; max-width: 22rem; width: 90%; }
  h1 { font-size: 1.1rem; margin-top: 0; }
  p { font-size: .85rem; opacity: .8; }
  input, button { width: 100%; box-sizing: border-box; padding: .6rem;
                  border-radius: 8px; font-size: 1rem; }
  input { border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); }
  button { margin-top: .75rem; border: none; background: #4a5ecc; color: #fff;
           cursor: pointer; }
  .err { color: #c33; font-size: .85rem; }
</style></head><body>
<form method="post" action="/consent" autocomplete="off">
  <h1>${serviceName}</h1>
  <p>An MCP client is requesting access to your Lunch Money data.
     Enter the access token (<code>MCP_AUTH_TOKEN</code>) to approve.</p>
  ${error ? `<p class="err">${error}</p>` : ""}
  <input type="hidden" name="txn" value="${txn}">
  <input type="password" name="password" placeholder="Access token" required autofocus>
  <button type="submit">Authorize</button>
</form></body></html>`;

  const router = express.Router();

  // Claude's connector backend and browser-based clients (MCP Inspector)
  // both hit these endpoints cross-origin. No cookies are involved anywhere,
  // so a permissive CORS policy does not enable CSRF.
  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
    );
    res.set("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // RFC 8414 + RFC 9728 discovery. Clients probe both the bare path and the
  // /mcp-suffixed variant (path-aware discovery for the resource at /mcp).
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"])
    router.get(p, (_req, res) => res.json(asMetadata));
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])
    router.get(p, (_req, res) => res.json(prMetadata));

  // RFC 7591 dynamic client registration, open by design: registering a
  // client grants nothing — only the consent password turns a client into
  // an authorized one. The client_id is a signed blob carrying its own
  // redirect_uris, so no registry is kept.
  router.post("/register", express.json({ limit: "16kb" }), (req, res) => {
    const { redirect_uris: uris, client_name: name } = req.body ?? {};
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 8 || !uris.every(validRedirectUri)) {
      return res.status(400).json({
        error: "invalid_client_metadata",
        error_description: "redirect_uris must be https or loopback http URLs",
      });
    }
    const clientId = sign({
      t: "client",
      ru: uris,
      name: String(name ?? "").slice(0, 128),
      iat: now(),
      jti: randomBytes(8).toString("hex"),
    });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: now(),
      redirect_uris: uris,
      client_name: name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  router.get("/authorize", (req, res) => {
    const q = req.query;
    const client = verify(q.client_id, "client");
    // Never redirect when the client or redirect_uri can't be trusted.
    if (!client) return res.status(400).type("text/plain").send("invalid client_id");
    if (!client.ru.includes(q.redirect_uri))
      return res.status(400).type("text/plain").send("redirect_uri not registered");

    const back = (error) => {
      const u = new URL(q.redirect_uri);
      u.searchParams.set("error", error);
      if (q.state) u.searchParams.set("state", String(q.state));
      res.redirect(303, u.href);
    };
    if (q.response_type !== "code") return back("unsupported_response_type");
    // PKCE S256 is mandatory (OAuth 2.1) — no plain, no opting out.
    if (!q.code_challenge || (q.code_challenge_method ?? "S256") !== "S256")
      return back("invalid_request");

    const txn = sign({
      t: "txn",
      cid: b64url(sha256(String(q.client_id))),
      redirect_uri: q.redirect_uri,
      challenge: String(q.code_challenge),
      state: q.state ? String(q.state) : undefined,
      exp: now() + TXN_TTL_S,
      jti: randomBytes(8).toString("hex"),
    });
    res.type("html").send(consentPage({ txn }));
  });

  router.post("/consent", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    const txn = verify(req.body?.txn, "txn");
    if (!txn) return res.status(400).type("text/plain").send("expired or invalid request — restart the connection from your MCP client");
    if (!req.body?.password || !safeEqual(String(req.body.password), authPassword)) {
      // Flat-rate damping on top of Caddy's per-IP rate limit. The secret is
      // machine-generated (≥256-bit) so online guessing is hopeless anyway.
      await new Promise((r) => setTimeout(r, 750));
      return res.status(401).type("html").send(consentPage({ txn: req.body?.txn, error: "Wrong access token." }));
    }
    const code = sign({
      t: "code",
      cid: txn.cid,
      redirect_uri: txn.redirect_uri,
      challenge: txn.challenge,
      exp: now() + CODE_TTL_S,
      // Fresh jti per issued code — the replay guard burns a code on its
      // first redemption attempt, successful or not.
      jti: randomBytes(8).toString("hex"),
    });
    const u = new URL(txn.redirect_uri);
    u.searchParams.set("code", code);
    if (txn.state) u.searchParams.set("state", txn.state);
    res.redirect(303, u.href);
  });

  router.post("/token", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body ?? {};
    const fail = (error, status = 400) => res.status(status).json({ error });

    const issueTokens = (cid) =>
      res.json({
        access_token: sign({ t: "access", exp: now() + ACCESS_TTL_S, jti: randomBytes(8).toString("hex") }),
        token_type: "Bearer",
        expires_in: ACCESS_TTL_S,
        refresh_token: sign({ t: "refresh", cid, exp: now() + REFRESH_TTL_S, jti: randomBytes(8).toString("hex") }),
      });

    if (b.grant_type === "authorization_code") {
      const code = verify(b.code, "code");
      if (!code || codeSeen(code.jti, code.exp)) return fail("invalid_grant");
      if (!b.client_id || b64url(sha256(String(b.client_id))) !== code.cid) return fail("invalid_grant");
      if (b.redirect_uri !== code.redirect_uri) return fail("invalid_grant");
      const verifier = String(b.code_verifier ?? "");
      if (!verifier || b64url(sha256(verifier)) !== code.challenge) return fail("invalid_grant");
      return issueTokens(code.cid);
    }
    if (b.grant_type === "refresh_token") {
      const rt = verify(b.refresh_token, "refresh");
      if (!rt) return fail("invalid_grant");
      // Rotation: every refresh hands out a new refresh token; the 90-day
      // window slides as long as the connector stays in use.
      return issueTokens(rt.cid);
    }
    return fail("unsupported_grant_type");
  });

  const requireAuth = (req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
    if (m && verify(m[1], "access")) return next();
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer realm="${serviceName}", error="invalid_token", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
      )
      .json({ error: "invalid_token" });
  };

  return { router, requireAuth };
}
