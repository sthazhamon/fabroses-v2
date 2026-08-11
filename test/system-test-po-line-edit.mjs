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
  section("=== Editing a genuinely untouched line succeeds ===");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const editMod = await import("../functions/api/purchase-order-items/[id].js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const sbMod = await import("../functions/api/supplier-bills.js");
  const sitesMod = await import("../functions/api/sites.js");

  await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env });
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Linen" }), env })).json();
  const po = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cozy", items: [{ item_id: item.id, quantity_ordered: 50, rate: 100 }] }), env })).json();
  const line = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id).items[0];

  const editRes = await (await editMod.onRequestPatch({ request: req({ quantity_ordered: 60, rate: 110 }), env, params: { id: line.id } })).json();
  assert(editRes.ok, "editing an untouched line succeeds");

  const lineAfter = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id).items[0];
  assert(lineAfter.quantity_ordered === 60 && lineAfter.rate === 110, "the new quantity and rate are correctly saved");

  section("=== Editing is blocked once any receiving has happened ===");
  await receiveMod.onRequestPost({ request: req({ quantity_received: 10 }), env, params: { id: line.id } });
  const blockedByReceive = await (await editMod.onRequestPatch({ request: req({ rate: 200 }), env, params: { id: line.id } })).json();
  assert(blockedByReceive.error, "editing is correctly blocked once any material has been received against this line");

  section("=== Editing is blocked once any billing has happened ===");
  const item2 = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk" }), env })).json();
  const po2 = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cozy", items: [{ item_id: item2.id, quantity_ordered: 20, rate: 50 }] }), env })).json();
  const line2 = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po2.id).items[0];
  await receiveMod.onRequestPost({ request: req({ quantity_received: 20 }), env, params: { id: line2.id } });
  await sbMod.onRequestPost({ request: req({ purchase_order_id: po2.id, supplier_name: "Cozy", lines: [{ purchase_order_item_id: line2.id, item_id: item2.id, quantity: 20, rate: 50 }] }), env, data: {} });

  const blockedByBill = await (await editMod.onRequestPatch({ request: req({ rate: 999 }), env, params: { id: line2.id } })).json();
  assert(blockedByBill.error, "editing is correctly blocked once this line has been billed");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
