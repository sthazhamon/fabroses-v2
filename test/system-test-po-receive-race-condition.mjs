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
  section("=== Setup: a PO line ordered for exactly 1 unit ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Peacock Applique Green" }), env })).json();
  const po = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", items: [{ item_id: item.id, quantity_ordered: 1, rate: 40 }] }), env })).json();
  const poLine = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id).items[0];

  section("=== CRITICAL: the exact race scenario - two requests both see the same stale line state ===");
  // This simulates what two nearly-simultaneous HTTP requests would look
  // like: both read the PO line's state BEFORE either one has written
  // anything, mimicking the window where a slow first request outlasts a
  // frontend double-click cooldown and a second, genuine request slips in
  // while the first is still in flight.
  const staleLineSnapshotForRequestA = await env.DB.prepare("SELECT * FROM purchase_order_items WHERE id = ?").bind(poLine.id).first();
  const staleLineSnapshotForRequestB = await env.DB.prepare("SELECT * FROM purchase_order_items WHERE id = ?").bind(poLine.id).first();
  assert(staleLineSnapshotForRequestA.quantity_received === 0 && staleLineSnapshotForRequestB.quantity_received === 0,
    "both simulated requests correctly start from the identical, stale 'nothing received yet' state");

  const requestAResult = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 1, site_id: store.id }), env, params: { id: poLine.id } })).json();
  assert(!requestAResult.error && requestAResult.lot_id, "request A correctly succeeds - it's genuinely the first to commit");

  const requestBResult = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 1, site_id: store.id }), env, params: { id: poLine.id } })).json();
  assert(requestBResult.error, `CRITICAL: request B is correctly rejected, even though it started from the exact same stale state as request A - got: ${JSON.stringify(requestBResult)}`);

  const lotsCreated = await env.DB.prepare("SELECT COUNT(*) AS c FROM item_lots WHERE source_reference = ?").bind(po.id).first();
  assert(lotsCreated.c === 1, `CRITICAL: exactly ONE lot was created, not two - the exact reported scenario (double receipt) is now prevented, got ${lotsCreated.c}`);

  const finalLine = await env.DB.prepare("SELECT quantity_received, status FROM purchase_order_items WHERE id = ?").bind(poLine.id).first();
  assert(finalLine.quantity_received === 1 && finalLine.status === "received", `the line correctly shows exactly 1 received, fully closed - got ${finalLine.quantity_received}/${finalLine.status}`);

  section("=== A legitimate second receipt, after genuinely more was ordered, still works correctly ===");
  const po2 = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", items: [{ item_id: item.id, quantity_ordered: 5, rate: 40 }] }), env })).json();
  const po2Line = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po2.id).items[0];
  const partial1 = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 2, site_id: store.id }), env, params: { id: po2Line.id } })).json();
  assert(!partial1.error, "a legitimate partial receipt correctly succeeds");
  const partial2 = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 3, site_id: store.id }), env, params: { id: po2Line.id } })).json();
  assert(!partial2.error, "a legitimate second partial receipt, correctly totaling exactly what was ordered, also succeeds");
  const finalLine2 = await env.DB.prepare("SELECT quantity_received, status FROM purchase_order_items WHERE id = ?").bind(po2Line.id).first();
  assert(finalLine2.quantity_received === 5 && finalLine2.status === "received", "two genuine, sequential partial receipts correctly sum to fully received");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
