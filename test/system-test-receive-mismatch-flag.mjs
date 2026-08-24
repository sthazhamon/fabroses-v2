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
  section("=== The exact reported scenario: worker sends 1, store types 2 at receipt ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();

  const dispatchId = await createDispatch(env, { dispatch_type: "return_shipment", from_site_id: worker.id, to_site_id: store.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 1 }] });
  await confirmPick(env, dispatchId, { item_id: item.id, lot_id: lot.id, scanned_quantity: 1 });
  await shipDispatch(env, dispatchId, {}, "Zakir");
  const dItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();

  const receiveRes = await confirmReceive(env, dispatchId, [{ dispatch_item_id: dItem.id, received_quantity: 2 }], "Store staff");
  assert(!receiveRes.error, "the receipt itself is still allowed to proceed - this is a flag, not a hard block");

  const dItemAfter = await env.DB.prepare("SELECT * FROM dispatch_items WHERE id = ?").bind(dItem.id).first();
  assert(dItemAfter.received_quantity === 2, "the received quantity is correctly recorded as entered");
  assert(dItemAfter.receive_mismatch_flag === 1, "CRITICAL: receiving 2 when only 1 was actually shipped is now correctly flagged as a mismatch");

  section("=== A receipt that genuinely matches what was shipped is correctly NOT flagged ===");
  const lot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  const dispatchId2 = await createDispatch(env, { dispatch_type: "return_shipment", from_site_id: worker.id, to_site_id: store.id, items: [{ item_id: item.id, lot_id: lot2.id, expected_quantity: 3 }] });
  await confirmPick(env, dispatchId2, { item_id: item.id, lot_id: lot2.id, scanned_quantity: 3 });
  await shipDispatch(env, dispatchId2, {}, "Zakir");
  const dItem2 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId2).first();
  await confirmReceive(env, dispatchId2, [{ dispatch_item_id: dItem2.id, received_quantity: 3 }], "Store staff");
  const dItem2After = await env.DB.prepare("SELECT receive_mismatch_flag FROM dispatch_items WHERE id = ?").bind(dItem2.id).first();
  assert(dItem2After.receive_mismatch_flag === 0, "a receipt that genuinely matches the scanned quantity is correctly NOT flagged");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
