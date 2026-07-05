// Smoke test: boots server.mjs with dummy credentials and exercises the
// complete OAuth 2.1 flow plus authenticated MCP calls. Run by CI (see
// .github/workflows/lunchmoney-mcp-image.yml) and usable locally:
//
//   node smoke-test.mjs
//
// Makes no outbound calls — the Lunch Money API is only contacted by tool
// invocations, which this test does not perform.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "smoke-test-secret-0123456789abcdef0123456789abcdef";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const srv = spawn("node", ["server.mjs"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    BASE_URL: BASE,
    MCP_AUTH_TOKEN: SECRET,
    LUNCHMONEY_API_TOKEN: "fake-token-for-smoke-test",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((res, rej) => {
  srv.stdout.on("data", (d) => d.toString().includes("listening") && res());
  srv.on("exit", (c) => rej(new Error(`server exited with ${c} before listening`)));
  setTimeout(() => rej(new Error("startup timeout")), 5000);
});

const form = (path, body) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });

try {
  // Discovery (RFC 8414 + RFC 9728, bare and /mcp-suffixed variants)
  for (const p of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const r = await fetch(BASE + p);
    const j = await r.json();
    check(`discovery ${p}`, r.status === 200 && (j.issuer === BASE || j.resource === `${BASE}/mcp`), JSON.stringify(j));
  }

  // Dynamic client registration
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  let r = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "smoke" }),
  });
  const reg = await r.json();
  check("DCR returns client_id", r.status === 201 && !!reg.client_id);

  r = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["ftp://evil.example"] }),
  });
  check("DCR rejects non-https redirect_uri", r.status === 400);

  // Authorization request → consent form
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authQs = (overrides = {}) =>
    new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz123",
      ...overrides,
    });
  r = await fetch(`${BASE}/authorize?${authQs()}`);
  const txn = /name="txn" value="([^"]+)"/.exec(await r.text())?.[1];
  check("authorize renders consent form", r.status === 200 && !!txn);

  r = await fetch(`${BASE}/authorize?${authQs({ client_id: "bogus" })}`);
  check("authorize rejects bogus client_id (no redirect)", r.status === 400);
  r = await fetch(`${BASE}/authorize?${authQs({ redirect_uri: "https://evil.example/cb" })}`);
  check("authorize rejects unregistered redirect_uri", r.status === 400);

  // Consent: wrong password refused, right password redirects with code
  r = await form("/consent", { txn, password: "wrong" });
  check("consent rejects wrong password", r.status === 401);
  r = await form("/consent", { txn, password: SECRET });
  const loc = new URL(r.headers.get("location"));
  const code = loc.searchParams.get("code");
  check("consent redirects with code + state", r.status === 303 && !!code && loc.searchParams.get("state") === "xyz123");

  // Token endpoint: PKCE enforced, single-use codes, refresh rotation
  const exchange = (c, v) =>
    form("/token", { grant_type: "authorization_code", code: c, client_id: reg.client_id, redirect_uri: redirectUri, code_verifier: v });
  r = await exchange(code, "not-the-verifier");
  check("token rejects bad PKCE verifier", r.status === 400 && (await r.json()).error === "invalid_grant");

  // A code is burned on its first redemption attempt — get a fresh one.
  r = await form("/consent", { txn, password: SECRET });
  const code2 = new URL(r.headers.get("location")).searchParams.get("code");
  r = await exchange(code2, verifier);
  const tok = await r.json();
  check("token exchange succeeds", r.status === 200 && !!tok.access_token && !!tok.refresh_token && tok.token_type === "Bearer");
  r = await exchange(code2, verifier);
  check("code replay rejected", r.status === 400);

  r = await form("/token", { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id });
  const tok2 = await r.json();
  check("refresh grant rotates tokens", r.status === 200 && !!tok2.access_token && tok2.refresh_token !== tok.refresh_token);

  // MCP endpoint: 401 without token, JSON-RPC with token
  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
  };
  const mcp = (body, auth, method = "POST") =>
    fetch(`${BASE}/mcp`, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
  r = await mcp(initBody, null);
  check("unauthenticated /mcp → 401 + resource_metadata", r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes("resource_metadata"));
  r = await mcp(initBody, "forged.token");
  check("forged bearer rejected", r.status === 401);

  r = await mcp(initBody, tok2.access_token);
  const init = await r.json();
  check("authed initialize returns serverInfo", r.status === 200 && !!init.result?.serverInfo, JSON.stringify(init).slice(0, 200));
  r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, tok2.access_token);
  const tools = await r.json();
  check("tools/list returns tools", r.status === 200 && (tools.result?.tools?.length ?? 0) > 0);

  r = await mcp(null, tok2.access_token, "GET");
  check("GET /mcp → 405 (stateless)", r.status === 405);

  r = await fetch(`${BASE}/healthz`);
  check("healthz unauthenticated", r.status === 200 && (await r.text()) === "ok");
} finally {
  srv.kill("SIGTERM");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
