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
  section("=== Setup: a two-line PO, fully received ===");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const sitesMod = await import("../functions/api/sites.js");

  await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env });
  const itemA = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const itemB = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk" }), env })).json();
  const po = await (await poMod.onRequestPost({ request: req({ supplier_name: "Neelam", items: [{ item_id: itemA.id, quantity_ordered: 50, rate: 200 }, { item_id: itemB.id, quantity_ordered: 20, rate: 500 }] }), env })).json();
  const poRow = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id);
  const lineA = poRow.items.find((i) => i.item_id === itemA.id);
  const lineB = poRow.items.find((i) => i.item_id === itemB.id);
  await receiveMod.onRequestPost({ request: req({ quantity_received: 50 }), env, params: { id: lineA.id } });
  await receiveMod.onRequestPost({ request: req({ quantity_received: 20 }), env, params: { id: lineB.id } });

  section("=== Billing only ONE line of the PO first (partial billing) ===");
  const sbMod = await import("../functions/api/supplier-bills.js");
  const bill1 = await (await sbMod.onRequestPost({
    request: req({ purchase_order_id: po.id, supplier_name: "Neelam", bill_number: "INV1", lines: [{ purchase_order_item_id: lineA.id, item_id: itemA.id, quantity: 50, rate: 200 }] }), env, data: {},
  })).json();
  assert(bill1.amount === 10000, "first bill correctly totals just this one line (50 x 200 = 10000)");

  const poAfterBill1 = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id);
  assert(poAfterBill1.bill_status === "not_billed", "PO's bill_status correctly stays not_billed — only ONE of its two lines has an actual bill yet");

  section("=== Billing the SECOND line completes it ===");
  const bill2 = await (await sbMod.onRequestPost({
    request: req({ purchase_order_id: po.id, supplier_name: "Neelam", bill_number: "INV2", lines: [{ purchase_order_item_id: lineB.id, item_id: itemB.id, quantity: 20, rate: 500 }] }), env, data: {},
  })).json();
  assert(bill2.amount === 10000, "second bill correctly totals its own line (20 x 500 = 10000)");

  const poAfterBill2 = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id);
  assert(poAfterBill2.bill_status === "billed", "NOW, with both lines billed across two separate bills, the PO's bill_status correctly flips to billed");

  section("=== Cash purchase (no PO) still works as its own track ===");
  const cashBill = await (await sbMod.onRequestPost({
    request: req({ purchase_order_id: null, supplier_name: "Local shop", lines: [{ item_id: null, quantity: 1, rate: 200 }] }), env, data: {},
  })).json();
  assert(cashBill.id, "a cash purchase with no PO behind it still works, unaffected by any of the PO-line logic above");

  section("=== A PARTIALLY received line can be billed without waiting for the rest — the exact reported bug ===");
  const itemC = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Cotton" }), env })).json();
  const po2 = await (await poMod.onRequestPost({ request: req({ supplier_name: "Neelam", items: [{ item_id: itemC.id, quantity_ordered: 100, rate: 50 }] }), env })).json();
  const po2Row = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po2.id);
  const lineC = po2Row.items[0];
  await receiveMod.onRequestPost({ request: req({ quantity_received: 30 }), env, params: { id: lineC.id } }); // only 30 of 100 arrived so far

  const partialBill = await (await sbMod.onRequestPost({
    request: req({ purchase_order_id: po2.id, supplier_name: "Neelam", bill_number: "INV3", lines: [{ purchase_order_item_id: lineC.id, item_id: itemC.id, quantity: 30, rate: 50 }] }), env, data: {},
  })).json();
  assert(partialBill.amount === 1500, "billing just the 30 that actually arrived succeeds, without needing all 100 first (30 x 50 = 1500)");

  const po2AfterBill = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po2.id);
  const lineCAfter = po2AfterBill.items[0];
  assert(lineCAfter.quantity_billed === 30, `the line correctly shows quantity_billed=30 — real data, not a status flag that never gets set (got ${lineCAfter.quantity_billed})`);

  section("=== And that same line correctly disappears from 'still outstanding' once fully billed ===");
  await receiveMod.onRequestPost({ request: req({ quantity_received: 70 }), env, params: { id: lineC.id } }); // the rest arrives later
  const secondPartialBill = await (await sbMod.onRequestPost({
    request: req({ purchase_order_id: po2.id, supplier_name: "Neelam", bill_number: "INV4", lines: [{ purchase_order_item_id: lineC.id, item_id: itemC.id, quantity: 70, rate: 50 }] }), env, data: {},
  })).json();
  assert(secondPartialBill.amount === 3500, "billing the remaining 70 separately works correctly (70 x 50 = 3500)");

  const po2Final = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po2.id);
  const lineCFinal = po2Final.items[0];
  assert(lineCFinal.quantity_billed === 100 && lineCFinal.quantity_received === 100,
    `CRITICAL: quantity_billed correctly reflects BOTH bills summed (30+70=100), matching quantity_received exactly — nothing double-billed, nothing missed (got billed=${lineCFinal.quantity_billed})`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
