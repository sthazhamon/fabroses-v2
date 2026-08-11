import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${l}`); } }
function section(t) { console.log(`\n${t}`); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }

async function run() {
  section("=== Setup: a plain pending dispatch ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick } = await import("../functions/api/_dispatch.js");
  const cancelMod = await import("../functions/api/dispatches/[id]/cancel.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();
  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 5 }] });

  section("=== Cancelling while pending_pick succeeds cleanly, touching nothing ===");
  const cancelRes = await (await cancelMod.onRequestPost({ env, params: { id: dispatchId } })).json();
  assert(cancelRes.ok, "cancellation succeeds while pending_pick");

  const dispatchAfter = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(dispatchId).first();
  assert(dispatchAfter.status === "cancelled", "the dispatch is correctly marked cancelled");

  const lotAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE id = ?").bind(lot.id).first();
  assert(lotAfter.quantity_balance === 10, `CRITICAL: the source lot's balance is completely untouched (still 10) — nothing had physically moved yet, got ${lotAfter.quantity_balance}`);

  section("=== Once picked, cancellation is correctly blocked ===");
  const lot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();
  const dispatchId2 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot2.id, expected_quantity: 5 }] });
  await confirmPick(env, dispatchId2, { item_id: item.id, lot_id: lot2.id, scanned_quantity: 5 });

  const blockedAttempt = await (await cancelMod.onRequestPost({ env, params: { id: dispatchId2 } })).json();
  assert(blockedAttempt.error, "cancelling a dispatch that's already been picked is correctly rejected");

  const dispatch2After = await env.DB.prepare("SELECT status FROM dispatches WHERE id = ?").bind(dispatchId2).first();
  assert(dispatch2After.status === "picked", "the dispatch correctly stays at picked, unaffected by the rejected cancel attempt");

  section("=== A non-existent dispatch is handled cleanly ===");
  const notFoundAttempt = await (await cancelMod.onRequestPost({ env, params: { id: "DSP-999999" } })).json();
  assert(notFoundAttempt.error, "attempting to cancel a dispatch that doesn't exist returns a clean error, not a crash");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
