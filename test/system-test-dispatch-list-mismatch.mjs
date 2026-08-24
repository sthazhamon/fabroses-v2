import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log("  \x1b[32m\u2713\x1b[0m " + l); } else { failed++; console.log("  \x1b[31m\u2717 FAIL\x1b[0m " + l); } }
function section(t) { console.log("\n" + t); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }

async function run() {
  section("=== The dispatches list correctly surfaces a mismatched receipt ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const dispatchesMod = await import("../functions/api/dispatches.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();

  const mismatchDispatchId = await createDispatch(env, { dispatch_type: "return_shipment", from_site_id: worker.id, to_site_id: store.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 1 }] });
  await confirmPick(env, mismatchDispatchId, { item_id: item.id, lot_id: lot.id, scanned_quantity: 1 });
  await shipDispatch(env, mismatchDispatchId, {}, "Zakir");
  const mismatchItem = await env.DB.prepare("SELECT id FROM dispatch_items WHERE dispatch_id = ?").bind(mismatchDispatchId).first();
  await confirmReceive(env, mismatchDispatchId, [{ dispatch_item_id: mismatchItem.id, received_quantity: 2 }], "Store staff");

  const lot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  const cleanDispatchId = await createDispatch(env, { dispatch_type: "return_shipment", from_site_id: worker.id, to_site_id: store.id, items: [{ item_id: item.id, lot_id: lot2.id, expected_quantity: 3 }] });
  await confirmPick(env, cleanDispatchId, { item_id: item.id, lot_id: lot2.id, scanned_quantity: 3 });
  await shipDispatch(env, cleanDispatchId, {}, "Zakir");
  const cleanItem = await env.DB.prepare("SELECT id FROM dispatch_items WHERE dispatch_id = ?").bind(cleanDispatchId).first();
  await confirmReceive(env, cleanDispatchId, [{ dispatch_item_id: cleanItem.id, received_quantity: 3 }], "Store staff");

  const list = await (await dispatchesMod.onRequestGet({ env })).json();
  const mismatchEntry = list.find(function (d) { return d.id === mismatchDispatchId; });
  const cleanEntry = list.find(function (d) { return d.id === cleanDispatchId; });

  assert(mismatchEntry.has_receive_mismatch === true, "CRITICAL: the dispatch with a mismatched receipt is correctly flagged");
  assert(cleanEntry.has_receive_mismatch === false, "the clean dispatch is correctly not flagged");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch(function (e) { console.error("CRASHED:", e); process.exit(1); });
