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
  section("=== Setup: a plain raw-material transfer (the generic branch that never surfaced its new lot before) ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();

  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 10 }] });
  await confirmPick(env, dispatchId, { item_id: item.id, lot_id: lot.id, scanned_quantity: 10 });
  await shipDispatch(env, dispatchId, {}, "store staff");
  const dispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();

  section("=== CRITICAL: confirmReceive now correctly returns the new lot's ID for the generic branch ===");
  const result = await confirmReceive(env, dispatchId, [{ dispatch_item_id: dispItem.id, received_quantity: 10 }], "Zakir");
  assert(result.created_lot_ids && result.created_lot_ids.length === 1, `created_lot_ids correctly has exactly 1 entry (got ${JSON.stringify(result.created_lot_ids)})`);
  assert(result.created_lot_ids[0].item_id === item.id, "each entry correctly carries its item_id too, not just a bare lot ID — needed to build a correct item_code|lot_id QR");

  const newLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(result.created_lot_ids[0].lot_id).first();
  assert(newLot && newLot.site_id === worker.id && newLot.quantity_balance === 10, "the returned lot ID genuinely corresponds to the real new lot just created");

  section("=== The dispatch detail endpoint shows the from-site name, ready for the confirm screen to display it ===");
  const dispatchDetailMod = await import("../functions/api/dispatches/[id].js");
  const detail = await (await dispatchDetailMod.onRequestGet({ params: { id: dispatchId }, env })).json();
  assert(detail.from_site_name === "Store", "from_site_name is present and correct — the confirm screen has what it needs");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
