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
  section("=== Setup: a worker who has shipped one dispatch already ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch } = await import("../functions/api/_dispatch.js");
  const workerPlaceMod = await import("../functions/api/worker-place.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 10, source_type: "opening_stock" }), env, data: {} })).json();

  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: worker.id, to_site_id: store.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 4 }] });
  await confirmPick(env, dispatchId, { item_id: item.id, lot_id: lot.id, scanned_quantity: 4 });
  await shipDispatch(env, dispatchId, {}, "Zakir");

  section("=== worker-place now includes their recent shipment ===");
  const res = await (await workerPlaceMod.onRequestGet({ env, data: { user: { siteId: worker.id } } })).json();
  assert(Array.isArray(res.recent_shipments) && res.recent_shipments.length === 1, "CRITICAL: the worker's recent shipment is correctly included");
  assert(res.recent_shipments[0].id === dispatchId, "the correct dispatch is the one shown");
  assert(res.recent_shipments[0].item_summary.includes("Kota"), "the item summary correctly describes what was shipped");

  section("=== A different worker with no shipments sees an empty list ===");
  const otherWorker = await (await sitesMod.onRequestPost({ request: req({ name: "Mortaja", site_type: "worker" }), env })).json();
  const otherRes = await (await workerPlaceMod.onRequestGet({ env, data: { user: { siteId: otherWorker.id } } })).json();
  assert(otherRes.recent_shipments.length === 0, "CRITICAL: a different worker's shipment history is correctly empty");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
