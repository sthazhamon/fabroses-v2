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
  section("=== Setup: an original sale, then a return of that same item ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const salesMod = await import("../functions/api/sales.js");
  const saleReturnsMod = await import("../functions/api/sale-returns.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });

  const originalSale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Peacock Applique", sale_price: 5000 }], customer_name: "Susan" }), env, data: {} })).json();
  const originalSaleItem = await env.DB.prepare("SELECT id FROM sale_items WHERE sale_id = ?").bind(originalSale.id).first();
  const returnRes = await (await saleReturnsMod.onRequestPost({ request: req({ sale_item_id: originalSaleItem.id, quantity: 1, site_id: store.id }), env, data: {} })).json();

  const returnedLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(returnRes.lot_id).first();
  assert(returnedLot.source_type === "sales_return", "the returned item correctly creates a sales_return lot");

  section("=== CRITICAL: selling that returned lot with NO description typed in - the exact reported scenario ===");
  const resellSaleRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, lot_id: returnRes.lot_id, quantity: 1, sale_price: 4500 }] }), env, data: {},
  })).json();
  assert(!resellSaleRes.error, `CRITICAL: selling a sales-return item with no manually-typed description correctly succeeds, no longer blocked - got error: ${resellSaleRes.error}`);
  assert(resellSaleRes.id, "the resale correctly went through and produced a real sale record");

  const resoldItem = await env.DB.prepare("SELECT * FROM sale_items WHERE sale_id = ?").bind(resellSaleRes.id).first();
  assert(resoldItem.description === "Peacock Applique", `CRITICAL: the description was correctly auto-derived from the item's own name, got "${resoldItem.description}"`);

  section("=== A genuinely missing description with NO item selected is still correctly rejected ===");
  const noItemNoDescRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ quantity: 1, sale_price: 100 }] }), env, data: {},
  })).json();
  assert(noItemNoDescRes.error, "a free-text line with neither an item nor a description is still correctly rejected - the fallback only applies when an item is actually selected");

  section("=== An explicitly-typed description is still respected, not overridden by the item's name ===");
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });
  const customDescRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, quantity: 1, sale_price: 4000, description: "Custom gift-wrapped applique" }] }), env, data: {},
  })).json();
  const customDescItem = await env.DB.prepare("SELECT * FROM sale_items WHERE sale_id = ?").bind(customDescRes.id).first();
  assert(customDescItem.description === "Custom gift-wrapped applique", "an explicitly typed description is correctly kept as-is, not silently overridden by the item's name");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
