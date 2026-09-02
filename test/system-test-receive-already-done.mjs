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
  section("=== The exact reported scenario: a duplicate confirm on an already-received dispatch ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();

  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 3 }] });
  await confirmPick(env, dispatchId, { item_id: item.id, lot_id: lot.id, scanned_quantity: 3 });
  await shipDispatch(env, dispatchId, {}, "store staff");
  const dItem = await env.DB.prepare("SELECT id FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();

  const firstRes = await confirmReceive(env, dispatchId, [{ dispatch_item_id: dItem.id, received_quantity: 3 }], "Zakir");
  assert(!firstRes.error, "the first, genuine confirm correctly succeeds");

  const stockAfterFirst = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ? AND site_id = ?").bind(item.id, worker.id).first();
  assert(stockAfterFirst.quantity_balance === 3, "the worker correctly received the stock after the first confirm");

  section("=== A second, duplicate confirm attempt correctly gets a clear, non-alarming message ===");
  const secondRes = await confirmReceive(env, dispatchId, [{ dispatch_item_id: dItem.id, received_quantity: 3 }], "Zakir");
  assert(secondRes.error && secondRes.already_done === true, "CRITICAL: the second attempt is correctly distinguished as 'already done', not a generic failure");
  assert(secondRes.error.toLowerCase().includes("already"), "the message correctly explains the stock is already there, not implying something went wrong");

  const stockAfterSecond = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ? AND site_id = ?").bind(item.id, worker.id).first();
  assert(stockAfterSecond.quantity_balance === 3, "CRITICAL: the duplicate attempt correctly did NOT double-add stock - still exactly 3, not 6");

  section("=== A genuinely never-shipped dispatch still gets the original, distinct message ===");
  const lot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();
  const neverShippedId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot2.id, expected_quantity: 2 }] });
  const neverShippedItem = await env.DB.prepare("SELECT id FROM dispatch_items WHERE dispatch_id = ?").bind(neverShippedId).first();
  const neverShippedRes = await confirmReceive(env, neverShippedId, [{ dispatch_item_id: neverShippedItem.id, received_quantity: 2 }], "Zakir");
  assert(neverShippedRes.error && !neverShippedRes.already_done, "CRITICAL: a genuinely never-shipped dispatch is correctly NOT flagged as already_done - it's a real, distinct problem");
  assert(neverShippedRes.error.includes("hasn't been shipped"), "the never-shipped case keeps its own distinct, accurate message");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
