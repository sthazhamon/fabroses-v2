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
  section("=== Setup: a sale of 3 units ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const salesMod = await import("../functions/api/sales.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });
  const saleRes = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 3, description: "Saree x3", sale_price: 5000 }] }), env, data: {} })).json();
  const saleItem = await env.DB.prepare("SELECT * FROM sale_items WHERE sale_id = ?").bind(saleRes.id).first();

  section("=== Return happens with NO refund action at all — genuinely independent ===");
  const returnMod = await import("../functions/api/sale-returns.js");
  const stockBefore = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(item.id).first();
  assert(stockBefore.t === 2, "confirmed: after selling 3 of the original 5, stock correctly sits at 2 before any return");

  const returnRes = await (await returnMod.onRequestPost({ request: req({ sale_item_id: saleItem.id, quantity: 1 }), env, data: { user: { name: "Admin" } } })).json();
  assert(returnRes.ok && returnRes.lot_id, "a return succeeds on its own, with no refund involved anywhere in this call");

  const refundsCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM refunds").first();
  assert(refundsCount.c === 0, "CRITICAL: no refund record was created — return and refund are genuinely independent, exactly as specified");

  const journalCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE reference_type != 'sale'").first();
  assert(journalCount.c === 0, "and no money moved anywhere either — this is purely an inventory action");

  section("=== The returned item becomes its OWN new lot, not merged into the original ===");
  const returnedLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(returnRes.lot_id).first();
  assert(returnedLot.source_type === "sales_return" && returnedLot.site_id === store.id, "the return created a genuinely new, separately-identifiable lot at the store, matching how every other inbound movement works");

  const stockAfter = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(item.id).first();
  assert(stockAfter.t === 3, `stock correctly went back up by exactly 1 (2 -> 3), got ${stockAfter.t}`);

  section("=== Can't return more than was actually sold on that line ===");
  const overReturn = await (await returnMod.onRequestPost({ request: req({ sale_item_id: saleItem.id, quantity: 10 }), env, data: {} })).json();
  assert(overReturn.error, "trying to return 10 when only 3 were sold (2 still returnable after the first return) is rejected");

  const exactRemaining = await (await returnMod.onRequestPost({ request: req({ sale_item_id: saleItem.id, quantity: 2 }), env, data: {} })).json();
  assert(exactRemaining.ok && exactRemaining.remaining_returnable === 0, "returning exactly the remaining 2 succeeds, leaving nothing further returnable on this line");

  const finalOverReturn = await (await returnMod.onRequestPost({ request: req({ sale_item_id: saleItem.id, quantity: 0.5 }), env, data: {} })).json();
  assert(finalOverReturn.error, "once fully returned (3 of 3), even a tiny additional return attempt is correctly rejected");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
