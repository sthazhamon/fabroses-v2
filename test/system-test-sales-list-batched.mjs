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
  section("=== Setup: two sales, each with two lines ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const salesMod = await import("../functions/api/sales.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const dupatta = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Dupatta" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: saree.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });
  await lotsMod.onRequestPost({ request: req({ item_id: dupatta.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });

  const sale1 = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: saree.id, quantity: 1, description: "Saree", sale_price: 5000 }, { item_id: dupatta.id, quantity: 1, description: "Dupatta", sale_price: 1000 }] }), env, data: {} })).json();
  const sale2 = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: saree.id, quantity: 1, description: "Saree", sale_price: 5500 }] }), env, data: {} })).json();

  section("=== CRITICAL: the batched list correctly attributes each sale's lines to the right sale ===");
  const list = await (await salesMod.onRequestGet({ env })).json();
  const sale1Result = list.find((s) => s.id === sale1.id);
  const sale2Result = list.find((s) => s.id === sale2.id);

  assert(sale1Result.lines.length === 2, `CRITICAL: sale1 correctly shows exactly its own 2 lines, got ${sale1Result.lines.length}`);
  assert(sale2Result.lines.length === 1, `CRITICAL: sale2 correctly shows exactly its own 1 line, not sale1's lines mixed in, got ${sale2Result.lines.length}`);
  assert(sale2Result.lines[0].sale_price === 5500, "sale2's own line correctly shows its own price, not sale1's");
  assert(sale1Result.lines.some((l) => l.item_name === "Dupatta"), "the item name is correctly joined in for each line");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
