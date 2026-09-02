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
  section("=== Setup: two POs, each with two lines, one partially billed ===");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const sitesMod = await import("../functions/api/sites.js");
  const sbMod = await import("../functions/api/supplier-bills.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const fabric = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const thread = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Thread" }), env })).json();

  const po1 = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", items: [{ item_id: fabric.id, quantity_ordered: 10, rate: 40 }, { item_id: thread.id, quantity_ordered: 5, rate: 20 }] }), env })).json();
  const po2 = await (await poMod.onRequestPost({ request: req({ supplier_name: "Silk House", items: [{ item_id: fabric.id, quantity_ordered: 8, rate: 42 }] }), env })).json();

  const po1Fetch = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po1.id);
  const fabricLineId = po1Fetch.items.find((i) => i.item_id === fabric.id).id;
  await receiveMod.onRequestPost({ request: req({ quantity_received: 10, site_id: store.id }), env, params: { id: fabricLineId } });
  await sbMod.onRequestPost({ request: req({ purchase_order_id: po1.id, supplier_name: "Cotton Threads", bill_date: "2026-09-01", lines: [{ purchase_order_item_id: fabricLineId, item_id: fabric.id, quantity: 6, rate: 40 }] }), env, data: {} });

  section("=== CRITICAL: the batched list correctly matches each PO to its OWN lines, not mixed up ===");
  const list = await (await poMod.onRequestGet({ env })).json();
  const po1Result = list.find((p) => p.id === po1.id);
  const po2Result = list.find((p) => p.id === po2.id);

  assert(po1Result.items.length === 2, `CRITICAL: PO1 correctly shows exactly its own 2 lines, not PO2's lines mixed in, got ${po1Result.items.length}`);
  assert(po2Result.items.length === 1, `CRITICAL: PO2 correctly shows exactly its own 1 line, got ${po2Result.items.length}`);

  const po1FabricLine = po1Result.items.find((i) => i.item_id === fabric.id);
  assert(po1FabricLine.quantity_billed === 6, `CRITICAL: the billed quantity is correctly attributed to the exact right line, got ${po1FabricLine.quantity_billed}`);
  const po1ThreadLine = po1Result.items.find((i) => i.item_id === thread.id);
  assert(po1ThreadLine.quantity_billed === 0, `CRITICAL: an unbilled line on the SAME PO correctly shows 0, not accidentally inheriting the other line's billed amount, got ${po1ThreadLine.quantity_billed}`);

  const po2Line = po2Result.items[0];
  assert(po2Line.quantity_billed === 0, "PO2's line, entirely unrelated to any bill, correctly shows 0 billed");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
