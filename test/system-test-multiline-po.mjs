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
  section("=== Setup ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const itemA = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota", unit_of_measure: "metre" }), env })).json();
  const itemB = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk", unit_of_measure: "metre" }), env })).json();

  section("=== Creating a multi-line PO ===");
  const poMod = await import("../functions/api/purchase-orders.js");
  const po = await (await poMod.onRequestPost({
    request: req({ supplier_name: "Neelam Fabrics", items: [{ item_id: itemA.id, quantity_ordered: 50, rate: 200 }, { item_id: itemB.id, quantity_ordered: 20, rate: 500 }] }), env,
  })).json();
  assert(po.id === "PO-000001", "created a two-line PO");

  const listAfterCreate = await (await poMod.onRequestGet({ env })).json();
  const poRow = listAfterCreate.find((p) => p.id === po.id);
  assert(poRow.items.length === 2 && poRow.status === "ordered", "PO shows both lines, derived status correctly 'ordered' before anything's received");

  section("=== Different lines received at genuinely different times ===");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const lineA = poRow.items.find((i) => i.item_id === itemA.id);
  const lineB = poRow.items.find((i) => i.item_id === itemB.id);

  const receiveA = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 50 }), env, params: { id: lineA.id } })).json();
  assert(receiveA.line_status === "received", "line A fully received on its own");

  const listAfterA = await (await poMod.onRequestGet({ env })).json();
  const poAfterA = listAfterA.find((p) => p.id === po.id);
  assert(poAfterA.status === "partially_received", "the WHOLE PO's derived status correctly shows partially_received — line A is done, line B isn't yet");

  const receiveBPartial = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 10 }), env, params: { id: lineB.id } })).json();
  assert(receiveBPartial.line_status === "partially_received", "line B itself can be partially received too, independently of line A being fully done");

  const overReceive = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 999 }), env, params: { id: lineB.id } })).json();
  assert(overReceive.error, "can't receive more than what's actually outstanding on that specific line");

  await receiveMod.onRequestPost({ request: req({ quantity_received: 10 }), env, params: { id: lineB.id } });
  const listAfterBoth = await (await poMod.onRequestGet({ env })).json();
  const poFinal = listAfterBoth.find((p) => p.id === po.id);
  assert(poFinal.status === "received", "once BOTH lines are fully received, the whole PO's derived status correctly shows received");

  const itemAStock = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(itemA.id).first();
  const itemBStock = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(itemB.id).first();
  assert(itemAStock.t === 50 && itemBStock.t === 20, `each item's stock landed correctly and independently (A=50, B=20, got A=${itemAStock.t}, B=${itemBStock.t})`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
