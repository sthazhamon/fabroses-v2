import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";
import { signToken } from "../functions/api/_auth.js";
import { onRequest as middleware } from "../functions/api/_middleware.js";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${l}`); } }
function section(t) { console.log(`\n${t}`); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const SECRET = "test-secret";
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: SECRET };

async function callAs(role, path) {
  await sqliteDb.exec(`DELETE FROM users WHERE username='roletest'`);
  sqliteDb.exec(`INSERT INTO users (name, username, pin_hash, pin_salt, role, token_version, active) VALUES ('Test', 'roletest', 'x', 'y', '${role}', 1, 1)`);
  const row = sqliteDb.prepare("SELECT id FROM users WHERE username='roletest'").get();
  const token = await signToken({ id: row.id, role, name: "Test", tokenVersion: 1, exp: Date.now() + 3600000 }, SECRET);
  const request = { url: "https://x" + path, headers: new Map([["Authorization", "Bearer " + token]]) };
  request.headers.get = Map.prototype.get.bind(request.headers);
  const next = async () => Response.json({ ok: true });
  return middleware({ request, env, data: {}, next });
}

async function run() {
  section("=== Dispatch role's trimmed access — Sites, Dispatch, Receive still allowed ===");
  assert((await (await callAs("dispatch", "/api/sites")).json()).ok, "sites still accessible");
  assert((await (await callAs("dispatch", "/api/dispatches")).json()).ok, "dispatches still accessible");
  assert((await (await callAs("dispatch", "/api/dispatch-queue")).json()).ok, "dispatch-queue still accessible");
  assert((await (await callAs("dispatch", "/api/receive-history")).json()).ok, "receive-history still accessible");

  section("=== Sales and Customer Orders are now correctly blocked ===");
  const salesAttempt = await callAs("dispatch", "/api/sales");
  assert(salesAttempt.status === 403, `sales is now correctly blocked for the dispatch role (got status ${salesAttempt.status})`);

  const coAttempt = await callAs("dispatch", "/api/customer-orders");
  assert(coAttempt.status === 403, `customer-orders is now correctly blocked for the dispatch role (got status ${coAttempt.status})`);

  section("=== PO receiving still works — needed for the inline Receive-tab control ===");
  assert((await (await callAs("dispatch", "/api/purchase-orders")).json()).ok, "purchase-orders still accessible, needed for inline receiving");
  assert((await (await callAs("dispatch", "/api/purchase-order-items")).json()).ok, "purchase-order-items still accessible");

  section("=== Admin and accountant remain completely unaffected ===");
  assert((await (await callAs("admin", "/api/sales")).json()).ok, "admin still has full sales access");
  assert((await (await callAs("accountant", "/api/customer-orders")).json()).ok, "accountant still has full customer-orders access");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
