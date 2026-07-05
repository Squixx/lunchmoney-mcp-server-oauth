// Unit tests for the schema-aware null pruner. Run: node sanitize.test.mjs
import assert from "node:assert/strict";
import { sanitizeRpcBody, pruneArguments } from "./sanitize.mjs";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL: ${name}\n      ${err.message}`);
  }
};

// Mirrors the real upstream get_transactions schema: end_date is a $ref to the
// non-nullable start_date string.
const getTransactionsSchema = {
  type: "object",
  properties: {
    start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    end_date: { $ref: "#/properties/start_date" },
    created_since: { type: "string" },
    updated_since: { $ref: "#/properties/created_since" },
    limit: { type: "number" },
  },
};

// Mirrors update_transaction: nested object with nullable clear-fields.
const updateTransactionSchema = {
  type: "object",
  properties: {
    transaction_id: { type: "number" },
    update: {
      type: "object",
      properties: {
        category_id: { type: ["number", "null"] },
        notes: { anyOf: [{ type: "string" }, { type: "null" }] },
        payee: { type: "string" },
      },
    },
  },
};

const bulkSchema = {
  type: "object",
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "number" },
          category_id: { type: ["number", "null"] },
          payee: { type: "string" },
        },
      },
    },
  },
};

const schemas = new Map([
  ["get_transactions", getTransactionsSchema],
  ["update_transaction", updateTransactionSchema],
  ["update_transactions_bulk", bulkSchema],
]);

const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

// --- the reported bug ---
check("drops $ref-forbidden null end_date, keeps start_date", () => {
  const body = call("get_transactions", { start_date: "2026-01-01", end_date: null });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, { start_date: "2026-01-01" });
});

check("drops both dates when both null", () => {
  const body = call("get_transactions", { start_date: null, end_date: null, limit: 5 });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, { limit: 5 });
});

check("drops $ref-forbidden null updated_since", () => {
  const body = call("get_transactions", { updated_since: null });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, {});
});

// --- the string-sentinel variant of the same bug ---
check('drops pattern-forbidden string "null" end_date, keeps start_date', () => {
  const body = call("get_transactions", { start_date: "2026-01-01", end_date: "null" });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, { start_date: "2026-01-01" });
});

check('drops string "undefined" on a pattern-constrained date field', () => {
  const body = call("get_transactions", { start_date: "undefined" });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, {});
});

check('drops string "null" on a numeric field (no string type)', () => {
  const body = call("get_transactions", { limit: "null" });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, {});
});

check('keeps string "null" on an unconstrained string field (created_since)', () => {
  const body = call("get_transactions", { created_since: "null" });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, { created_since: "null" });
});

check('keeps literal "null" payee — free-form string, could be a real value', () => {
  const body = call("update_transaction", { transaction_id: 7, update: { payee: "null" } });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, { transaction_id: 7, update: { payee: "null" } });
});

check('keeps string "null" on a nullable field — ambiguous, left for upstream', () => {
  const body = call("update_transaction", { transaction_id: 7, update: { category_id: "null" } });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, { transaction_id: 7, update: { category_id: "null" } });
});

// --- must NOT break intentional clears ---
check("keeps nullable category_id (union type) — clear field", () => {
  const body = call("update_transaction", { transaction_id: 7, update: { category_id: null, payee: "x" } });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, { transaction_id: 7, update: { category_id: null, payee: "x" } });
});

check("keeps nullable notes (anyOf null) — clear field", () => {
  const body = call("update_transaction", { transaction_id: 7, update: { notes: null } });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, { transaction_id: 7, update: { notes: null } });
});

check("keeps nullable clears inside array items", () => {
  const body = call("update_transactions_bulk", {
    transactions: [
      { id: 1, category_id: null },
      { id: 2, payee: "y" },
    ],
  });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments.transactions, [
    { id: 1, category_id: null },
    { id: 2, payee: "y" },
  ]);
});

// --- pass-through safety ---
check("non-tools/call messages untouched", () => {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const before = JSON.stringify(body);
  sanitizeRpcBody(body, schemas);
  assert.equal(JSON.stringify(body), before);
});

check("unknown tool untouched", () => {
  const body = call("some_other_tool", { end_date: null });
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body.params.arguments, { end_date: null });
});

check("empty schema map is a no-op", () => {
  const body = call("get_transactions", { end_date: null });
  sanitizeRpcBody(body, new Map());
  assert.deepEqual(body.params.arguments, { end_date: null });
});

check("batch array: each message sanitized", () => {
  const body = [
    call("get_transactions", { end_date: null }),
    call("update_transaction", { transaction_id: 1, update: { category_id: null } }),
  ];
  sanitizeRpcBody(body, schemas);
  assert.deepEqual(body[0].params.arguments, {});
  assert.deepEqual(body[1].params.arguments, { transaction_id: 1, update: { category_id: null } });
});

check("unknown property with null left for upstream to reject", () => {
  const args = { mystery: null };
  pruneArguments(args, getTransactionsSchema);
  assert.deepEqual(args, { mystery: null });
});

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
