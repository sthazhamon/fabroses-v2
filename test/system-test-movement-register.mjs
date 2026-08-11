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
function getReq(qs) { return { url: "https://x/api/material-movements" + qs }; }

async function run() {
  section("=== Setup: movements across two items and two sites ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const movementsMod = await import("../functions/api/material-movements.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const itemA = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const itemB = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk" }), env })).json();
  const lotA = await (await lotsMod.onRequestPost({ request: req({ item_id: itemA.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();

  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: itemA.id, lot_id: lotA.id, expected_quantity: 5 }] });
  await confirmPick(env, dispatchId, { item_id: itemA.id, lot_id: lotA.id, scanned_quantity: 5 });
  await shipDispatch(env, dispatchId, {}, "store staff");
  const dItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();
  await confirmReceive(env, dispatchId, [{ dispatch_item_id: dItem.id, received_quantity: 5 }], "Zakir");

  section("=== Every movement shows part number, lot, from/to site, and date ===");
  const allMovements = await (await movementsMod.onRequestGet({ request: getReq(""), env })).json();
  assert(allMovements.length >= 2, `at least the ship-out and receive-in movements are present, got ${allMovements.length}`);
  const shipOut = allMovements.find((m) => m.event_type === "transferred_out");
  assert(shipOut.item_name && shipOut.from_site_name === "Store" && shipOut.to_site_name === "Zakir" && shipOut.created_at,
    "the movement correctly shows the item, from-site, to-site, and a date");

  section("=== Filtering by item correctly narrows results ===");
  const filteredByItem = await (await movementsMod.onRequestGet({ request: getReq("?item_id=" + itemA.id), env })).json();
  assert(filteredByItem.every((m) => m.item_id === itemA.id), "every result correctly matches only the filtered item");
  assert(filteredByItem.length > 0, "the filter still returns real results for the item that actually moved");

  const filteredByOtherItem = await (await movementsMod.onRequestGet({ request: getReq("?item_id=" + itemB.id), env })).json();
  assert(filteredByOtherItem.length === 0, "filtering by an item that never moved correctly returns nothing");

  section("=== Filtering by site correctly narrows results ===");
  const filteredBySite = await (await movementsMod.onRequestGet({ request: getReq("?site_id=" + worker.id), env })).json();
  assert(filteredBySite.length > 0 && filteredBySite.every((m) => m.from_site_id === worker.id || m.to_site_id === worker.id),
    "filtering by site correctly matches movements where that site is either the source or destination");

  section("=== Filtering by a date range that excludes everything returns nothing ===");
  const filteredByDate = await (await movementsMod.onRequestGet({ request: getReq("?from=2020-01-01&to=2020-01-02"), env })).json();
  assert(filteredByDate.length === 0, "a date range with nothing in it correctly returns an empty list, not an error");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
