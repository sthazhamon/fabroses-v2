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
  section("=== Setup: a lot received fresh, and a lot that arrived via a transfer ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const stockBySiteMod = await import("../functions/api/stock-by-site.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique Green" }), env })).json();
  const freshLot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 2, source_type: "work_order_output" }), env, data: {} })).json();

  const dispatchId = await createDispatch(env, { dispatch_type: "return_shipment", from_site_id: worker.id, to_site_id: store.id, items: [{ item_id: item.id, lot_id: freshLot.id, expected_quantity: 1 }] });
  await confirmPick(env, dispatchId, { item_id: item.id, lot_id: freshLot.id, scanned_quantity: 1 });
  await shipDispatch(env, dispatchId, {}, "Zakir");
  const shippedItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();
  await confirmReceive(env, dispatchId, [{ dispatch_item_id: shippedItem.id, received_quantity: 1 }], "Store staff");

  section("=== CRITICAL: /stock-by-site correctly resolves the stable origin for every lot, not just the current id ===");
  const stockRes = await (await stockBySiteMod.onRequestGet({ env })).json();
  const workerEntry = stockRes.sites.find((s) => s.site.id === worker.id);
  const storeEntry = stockRes.sites.find((s) => s.site.id === store.id);

  const remainingFreshLot = workerEntry.lots.find((l) => l.id === freshLot.id);
  assert(remainingFreshLot.resolved_origin === freshLot.id, "a lot that was never transferred correctly resolves its own id as its origin");

  const transferredLot = storeEntry.lots.find((l) => l.item_id === item.id);
  assert(transferredLot.id !== freshLot.id, "confirmed this is genuinely a different, new lot at the destination");
  assert(transferredLot.resolved_origin === freshLot.id, `CRITICAL: the transferred lot correctly resolves back to the ORIGINAL lot as its stable origin, got ${transferredLot.resolved_origin}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
