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
//
// The same accident also shows up as the *string* "null" (or "undefined") when
// a caller templates an unset optional into JSON text, e.g.
// get_transactions({ end_date: "null" }). We prune those too, but only where
// the schema both forbids real null AND cannot accept the literal string —
// a date field with a `pattern`, a numeric field, an enum, etc. On a
// free-form string field (payee, notes) "null" is left untouched, because
// there it may well be a legitimate value.

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

// Could this schema node accept `str` as a valid string value? Used to decide
// whether a stray "null"/"undefined" string is a real value or a templated
// unset optional. Conservative: when we can't prove the string is rejected we
// return true (leave the value alone). We only return false when the schema
// clearly can't accept it — a non-string type, a failing pattern/format, an
// enum/const that excludes it, or a length bound it violates.
function permitsStringValue(schema, str, root, seen = new Set()) {
  if (!schema || typeof schema !== "object") return true;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return true; // cycle guard
    seen.add(schema.$ref);
    return permitsStringValue(resolveRef(schema.$ref, root), str, root, seen);
  }
  if (Array.isArray(schema.enum)) return schema.enum.includes(str);
  if ("const" in schema) return schema.const === str;
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) {
      return schema[key].some((s) => permitsStringValue(s, str, root, seen));
    }
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
  if (!types) return true; // untyped — can't prove rejection
  if (!types.includes("string")) return false; // a string can't satisfy a non-string type

  // It's (or may be) a string. Only a concrete constraint lets us reject it;
  // an unconstrained string field is free-form, where "null" could be real.
  if (typeof schema.format === "string" && schema.format) return false;
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern).test(str)) return false;
    } catch {
      /* unparseable pattern — don't rely on it */
    }
  }
  if (Number.isFinite(schema.maxLength) && str.length > schema.maxLength) return false;
  if (Number.isFinite(schema.minLength) && str.length < schema.minLength) return false;
  return true;
}

// Sentinel strings a caller may emit for an unset optional when templating JSON.
const SENTINEL_STRINGS = new Set(["null", "undefined"]);

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
      const v = value[key];
      if (v === null) {
        if (!permitsNull(propSchema, root)) delete value[key];
      } else if (typeof v === "string" && SENTINEL_STRINGS.has(v)) {
        // Templated unset optional: drop only where the schema forbids real
        // null AND can't accept this literal string. Never on a free-form
        // string, where "null" may be a legitimate value.
        if (!permitsNull(propSchema, root) && !permitsStringValue(propSchema, v, root)) {
          delete value[key];
        }
      } else {
        pruneValue(v, propSchema, root);
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
