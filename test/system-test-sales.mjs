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
  const lotsMod = await import("../functions/api/item-lots.js");
  const partiesMod = await import("../functions/api/parties.js");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree", price: 5000 }), env })).json();
  const item2 = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Blouse", price: 800 }), env })).json();
  const lot1 = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 3, source_type: "opening_stock" }), env, data: {} })).json();
  const lot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 2, source_type: "opening_stock" }), env, data: {} })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item2.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });
  const anu = await (await partiesMod.onRequestPost({ request: req({ name: "Anu", type: "customer" }), env })).json();

  section("=== Single-line sale with tax computes correctly and posts balanced ===");
  const salesMod = await import("../functions/api/sales.js");
  const saleRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Test", sale_price: 5000, tax_rate: 12 }], customer_party_id: anu.id }), env, data: { user: {} },
  })).json();
  assert(saleRes.lines[0].tax_amount === 600 && saleRes.total_amount === 5600, `12% tax on 5000 = 600 tax, 5600 total (got tax=${saleRes.lines[0].tax_amount}, total=${saleRes.total_amount})`);

  const je = await env.DB.prepare("SELECT * FROM journal_entries WHERE reference_id = ?").bind(saleRes.id).first();
  const jeLines = await env.DB.prepare("SELECT * FROM journal_lines WHERE journal_entry_id = ?").bind(je.id).all();
  const totalDebit = jeLines.results.reduce((s, l) => s + l.debit, 0);
  const totalCredit = jeLines.results.reduce((s, l) => s + l.credit, 0);
  assert(totalDebit === totalCredit && totalDebit === 5600, `the sale's journal entry balances (debit=credit=5600, got debit=${totalDebit} credit=${totalCredit})`);

  section("=== Genuine multi-line sale: two DIFFERENT items, each with its own tax rate, in ONE sale ===");
  const multiLineRes = await (await salesMod.onRequestPost({
    request: req({
      lines: [
        { item_id: item.id, quantity: 1, description: "Saree", sale_price: 5000, tax_rate: 12 },
        { item_id: item2.id, quantity: 2, description: "Blouse x2", sale_price: 800, tax_rate: 5 },
      ], customer_party_id: anu.id,
    }), env, data: {},
  })).json();
  assert(multiLineRes.total_amount === 6440, `two lines with DIFFERENT tax rates sum correctly (5600 + 840 = 6440, got ${multiLineRes.total_amount})`);

  const saleItemRows = await env.DB.prepare("SELECT * FROM sale_items WHERE sale_id = ?").bind(multiLineRes.id).all();
  assert(saleItemRows.results.length === 2, "both lines were actually saved as separate sale_items rows, not merged");

  const item2StockAfter = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(item2.id).first();
  assert(item2StockAfter.t === 3, `the SECOND item's own stock correctly dropped independently (5 - 2 = 3, got ${item2StockAfter.t})`);

  section("=== FIFO consumption by default (still per-line) ===");
  const lot1After = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot1.id).first();
  // lot1 started at 3: -1 from the single-line sale above, -1 from the multi-line sale's first line (same item) = 1.
  assert(lot1After.quantity_balance === 1, `FIFO correctly took from lot1 across BOTH sales so far (3 - 1 - 1 = 1, got ${lot1After.quantity_balance})`);

  section("=== Scanned-lot override bypasses FIFO, still per-line ===");
  await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, lot_id: lot2.id, quantity: 1, description: "Scanned specific piece", sale_price: 5000 }] }), env, data: {} });
  const lot1AfterScan = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot1.id).first();
  const lot2AfterScan = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot2.id).first();
  assert(lot1AfterScan.quantity_balance === 1 && lot2AfterScan.quantity_balance === 1,
    `scanning lot2 explicitly took from lot2 (2->1), leaving lot1 untouched at 1, even though FIFO would have picked lot1 (got lot1=${lot1AfterScan.quantity_balance}, lot2=${lot2AfterScan.quantity_balance})`);

  section("=== Party balance reflects both unpaid sales ===");
  const parties = await (await partiesMod.onRequestGet({ env })).json();
  const anuAfter = parties.find((p) => p.id === anu.id);
  assert(anuAfter.balance === 5600 + 6440, `Anu's balance shows both sales unpaid (got ${anuAfter.balance})`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
