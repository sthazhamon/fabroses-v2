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
  const lot1 = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 3, source_type: "opening_stock" }), env, data: {} })).json();
  const lot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 2, source_type: "opening_stock" }), env, data: {} })).json();
  const anu = await (await partiesMod.onRequestPost({ request: req({ name: "Anu", type: "customer" }), env })).json();

  section("=== Sale with tax computes correctly and posts balanced ===");
  const salesMod = await import("../functions/api/sales.js");
  const saleRes = await (await salesMod.onRequestPost({ request: req({ item_id: item.id, quantity: 1, description: "Test", customer_party_id: anu.id, sale_price: 5000, tax_rate: 12 }), env, data: { user: {} } })).json();
  assert(saleRes.tax_amount === 600 && saleRes.total_amount === 5600, `12% tax on 5000 = 600 tax, 5600 total (got tax=${saleRes.tax_amount}, total=${saleRes.total_amount})`);

  const je = await env.DB.prepare("SELECT * FROM journal_entries WHERE reference_id = ?").bind(saleRes.id).first();
  const lines = await env.DB.prepare("SELECT * FROM journal_lines WHERE journal_entry_id = ?").bind(je.id).all();
  const totalDebit = lines.results.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.results.reduce((s, l) => s + l.credit, 0);
  assert(totalDebit === totalCredit && totalDebit === 5600, `the sale's journal entry balances (debit=credit=5600, got debit=${totalDebit} credit=${totalCredit})`);

  section("=== FIFO consumption by default ===");
  const lot1After = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot1.id).first();
  assert(lot1After.quantity_balance === 2, `FIFO took from lot1 (created first) — 3 down to 2 (got ${lot1After.quantity_balance})`);

  section("=== Scanned-lot override bypasses FIFO ===");
  const saleRes2 = await (await salesMod.onRequestPost({ request: req({ item_id: item.id, lot_id: lot2.id, quantity: 1, description: "Scanned specific piece", sale_price: 5000 }), env, data: {} })).json();
  const lot1AfterScan = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot1.id).first();
  const lot2AfterScan = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot2.id).first();
  assert(lot1AfterScan.quantity_balance === 2 && lot2AfterScan.quantity_balance === 1,
    `scanning lot2 explicitly took from lot2, NOT lot1, even though FIFO would have picked lot1 (lot1 stays at 2, lot2 drops 2->1)`);

  section("=== Party balance reflects the unpaid sale ===");
  const parties = await (await partiesMod.onRequestGet({ env })).json();
  const anuAfter = parties.find((p) => p.id === anu.id);
  assert(anuAfter.balance === 5600, `Anu's balance shows the full unpaid 5600 (got ${anuAfter.balance})`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
