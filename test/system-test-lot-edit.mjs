import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${l}`); } }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }

async function run() {
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const editMod = await import("../functions/api/item-lots/[id].js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 20, source_type: "direct_intake" }), env, data: {} })).json();

  const negRes = await (await editMod.onRequestPatch({ request: req({ quantity_balance: -5 }), env, params: { id: lot.id }, data: {} })).json();
  assert(negRes.error, "correcting to a negative quantity is rejected");

  const res = await (await editMod.onRequestPatch({ request: req({ quantity_balance: 15, notes: "Recount found a typo" }), env, params: { id: lot.id }, data: { user: { name: "Admin" } } })).json();
  assert(res.ok && res.old_quantity === 20 && res.new_quantity === 15, `correction from 20 to 15 recorded (got old=${res.old_quantity}, new=${res.new_quantity})`);

  const lotAfter = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot.id).first();
  assert(lotAfter.quantity_balance === 15, "the lot's actual balance is correctly updated");

  const editLogRows = await env.DB.prepare("SELECT * FROM edit_log WHERE entity_type = 'item_lot' AND entity_id = ?").bind(lot.id).all();
  assert(editLogRows.results.some((r) => r.field === "quantity_balance" && r.old_value === "20" && r.new_value === "15"), "the correction is logged with old and new values, same as any other edit");

  const movement = await env.DB.prepare("SELECT * FROM item_movements WHERE lot_id = ? AND event_type = 'adjusted' ORDER BY id DESC LIMIT 1").bind(lot.id).first();
  assert(movement && movement.quantity === -5, "a movement record shows the actual delta (-5), not just the new absolute value");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
