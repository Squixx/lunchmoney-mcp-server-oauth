// Schema-aware null pruning for incoming tool-call arguments.
//
// Why this exists: the upstream @akutishevsky/lunchmoney-mcp tool schemas
// declare optional filters like get_transactions.start_date / end_date as
// `.optional()` but NOT `.nullable()`. Some MCP clients serialize an unset
// optional as an explicit `null` rather than omitting it, so a call like
// get_transactions({ end_date: null }) fails upstream zod validation with
// "Expected string, received null" before it ever runs.
//
// The fix is NOT to strip every null — several write tools (update_transaction,
// update_manual_account, ...) use null deliberately to CLEAR a field
// (category_id: null = uncategorize, notes: null = clear). Blanket stripping
// would silently turn those clears into no-ops.
//
// Instead we prune a null value only where the tool's own JSON Schema forbids
// null, and keep it everywhere the schema permits it. Driven entirely by the
// schemas the upstream server itself advertises (see loadToolSchemas in
// server.mjs), so it stays correct as tools change.

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Resolve a local JSON-Pointer $ref (e.g. "#/properties/start_date") against
// the tool's own input schema. Only same-document refs are supported — that's
// all the upstream schemas use.
function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .reduce((node, part) => {
      if (node == null) return undefined;
      return node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, root);
}

const deref = (schema, root) =>
  schema && typeof schema === "object" && schema.$ref ? resolveRef(schema.$ref, root) : schema;

// Does this schema node accept an explicit null? Unknown/unresolvable schemas
// return true (conservative: when we can't prove null is forbidden, we leave
// the value untouched rather than risk dropping something meaningful).
function permitsNull(schema, root, seen = new Set()) {
  if (!schema || typeof schema !== "object") return true;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return true; // cycle guard
    seen.add(schema.$ref);
    return permitsNull(resolveRef(schema.$ref, root), root, seen);
  }
  if (schema.nullable === true) return true;
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key]) && schema[key].some((s) => permitsNull(s, root, seen))) {
      return true;
    }
  }
  return false;
}

// Recursively remove schema-forbidden nulls from `value` in place, walking the
// schema alongside it so nested objects (update: {...}) and arrays
// (transactions: [{...}]) are handled too. Returns `value`.
function pruneValue(value, schema, root) {
  const s = deref(schema, root);
  if (!s || typeof s !== "object") return value;

  if (isPlainObject(value) && isPlainObject(s.properties)) {
    for (const key of Object.keys(value)) {
      const propSchema = s.properties[key];
      if (!propSchema) continue; // unknown prop — leave it for upstream to judge
      if (value[key] === null) {
        if (!permitsNull(propSchema, root)) delete value[key];
      } else {
        pruneValue(value[key], propSchema, root);
      }
    }
    return value;
  }

  if (Array.isArray(value) && s.items) {
    for (const el of value) pruneValue(el, s.items, root);
    return value;
  }

  return value;
}

// Prune one tool-call arguments object against its tool's input schema.
export function pruneArguments(args, inputSchema) {
  if (!isPlainObject(args) || !isPlainObject(inputSchema)) return args;
  return pruneValue(args, inputSchema, inputSchema);
}

// Sanitize a JSON-RPC message (or batch array) in place: for every tools/call
// whose tool schema we know, prune schema-forbidden nulls from its arguments.
// Anything else — other methods, unknown tools, non-objects — passes through
// untouched. `schemas` is a Map<toolName, inputSchema>.
export function sanitizeRpcBody(body, schemas) {
  if (!schemas || schemas.size === 0) return body;
  const messages = Array.isArray(body) ? body : [body];
  for (const msg of messages) {
    if (!isPlainObject(msg) || msg.method !== "tools/call") continue;
    const name = msg.params?.name;
    const args = msg.params?.arguments;
    if (typeof name === "string" && isPlainObject(args) && schemas.has(name)) {
      pruneArguments(args, schemas.get(name));
    }
  }
  return body;
}
