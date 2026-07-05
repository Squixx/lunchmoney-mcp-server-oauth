// Streamable-HTTP MCP server for Lunch Money, with built-in OAuth 2.1.
//
// Auth lives in this process (see oauth.mjs), not at the reverse proxy:
// claude.ai custom connectors (web + mobile) can only authenticate via
// OAuth, so an edge bearer-token check would lock out exactly the clients
// this server exists for. The Caddy in front of this container still
// terminates TLS, rate-limits, and only forwards the /mcp + OAuth paths.
//
// MCP transport is stateless: every POST /mcp gets a fresh server +
// transport pair that is torn down when the response closes. No session
// table, no Mcp-Session-Id, nothing to leak across clients, and any number
// of Claude surfaces can talk to it concurrently. The price is a GET SSE
// notification stream (not needed for Lunch Money's request/response tools).

import express from "express";
import { createServer } from "@akutishevsky/lunchmoney-mcp/server";
import { initializeConfig } from "@akutishevsky/lunchmoney-mcp/config";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOAuth } from "./oauth.mjs";
import { sanitizeRpcBody } from "./sanitize.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const { LUNCHMONEY_API_TOKEN, MCP_AUTH_TOKEN, BASE_URL } = process.env;

for (const [name, ok] of [
  ["LUNCHMONEY_API_TOKEN", !!LUNCHMONEY_API_TOKEN],
  // 32+ chars: the consent password doubles as the OAuth signing-key seed.
  ["MCP_AUTH_TOKEN (min 32 chars)", (MCP_AUTH_TOKEN ?? "").length >= 32],
  ["BASE_URL (public https URL, e.g. https://lm.example.com)", /^https?:\/\//.test(BASE_URL ?? "")],
]) {
  if (!ok) {
    console.error(`FATAL: missing or invalid env var: ${name}`);
    process.exit(1);
  }
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`FATAL: invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

initializeConfig(LUNCHMONEY_API_TOKEN);

// Cache each tool's advertised JSON Schema once at boot, by introspecting the
// upstream server over an in-memory transport pair. Used to prune
// schema-forbidden nulls from incoming tool-call arguments (see sanitize.mjs
// for the why). Schemas are static for a given upstream version, so one pass
// is enough. Fail-safe: if introspection ever throws, we log and carry on with
// an empty map, which makes sanitizing a no-op (i.e. prior behaviour).
async function loadToolSchemas() {
  const introspector = createServer("1.0.0");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-introspector", version: "1.0.0" });
  try {
    await introspector.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t.inputSchema]));
  } finally {
    await client.close().catch(() => {});
    await introspector.close().catch(() => {});
  }
}

let toolSchemas = new Map();
try {
  toolSchemas = await loadToolSchemas();
  console.log(`loaded schemas for ${toolSchemas.size} tools (null-argument sanitizer active)`);
} catch (err) {
  console.error("WARN: tool-schema introspection failed; null sanitizer disabled:", err);
}

const { router: oauthRouter, requireAuth } = createOAuth({
  baseUrl: BASE_URL,
  authPassword: MCP_AUTH_TOKEN,
  serviceName: "lunchmoney-mcp",
});

const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("ok"));

app.use(oauthRouter);

app.post("/mcp", requireAuth, express.json({ limit: "256kb" }), async (req, res) => {
  // Fresh pair per request (stateless mode). enableJsonResponse makes the
  // reply a plain JSON body instead of an SSE stream — simpler through the
  // proxy, and supported by every Streamable-HTTP client.
  const mcpServer = createServer("1.0.0");
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    mcpServer.close();
  });
  try {
    // Strip nulls the tool schema forbids (e.g. an unset optional a client
    // serialized as `null`), so they don't trip upstream validation. Keeps
    // nulls the schema allows — those clear fields on write tools.
    sanitizeRpcBody(req.body, toolSchemas);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "internal error" },
        id: null,
      });
    }
  }
});

// Stateless server: no standalone SSE stream, no sessions to delete.
app.all("/mcp", requireAuth, (_req, res) =>
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "stateless server: use POST" },
    id: null,
  }),
);

app.use((_req, res) => res.status(404).type("text/plain").send("not found"));

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`lunchmoney-mcp listening on 0.0.0.0:${PORT} (issuer: ${BASE_URL})`);
});

const shutdown = (signal) => {
  console.log(`received ${signal}, shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
