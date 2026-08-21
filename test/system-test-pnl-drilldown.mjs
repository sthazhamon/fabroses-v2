import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log("  \x1b[32m\u2713\x1b[0m " + l); } else { failed++; console.log("  \x1b[31m\u2717 FAIL\x1b[0m " + l); } }
function section(t) { console.log("\n" + t); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }
function getReq(path, qs) { return { url: "https://x/api/" + path + qs }; }

async function run() {
  section("=== Setup: a sale and a supplier bill, generating real journal entries ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const salesMod = await import("../functions/api/sales.js");
  const sbMod = await import("../functions/api/supplier-bills.js");
  const pnlMod = await import("../functions/api/reports/pnl.js");
  const ledgerMod = await import("../functions/api/ledger.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });
  await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 5000 }], customer_name: "Susan" }), env, data: { user: { name: "Admin" } } });
  await sbMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", lines: [{ quantity: 5, rate: 200 }] }), env, data: {} });

  section("=== P&L now includes resolved account IDs for drill-down ===");
  const pnlRes = await (await pnlMod.onRequestGet({ request: getReq("reports/pnl", ""), env })).json();
  assert(Array.isArray(pnlRes.net_revenue_account_ids) && pnlRes.net_revenue_account_ids.length === 2, "net_revenue correctly resolves to 2 account IDs");
  assert(Array.isArray(pnlRes.cogs_account_ids) && pnlRes.cogs_account_ids.length === 2, "cogs correctly resolves to 2 account IDs");
  assert(Array.isArray(pnlRes.expense_account_ids), "expenses correctly include a resolved list of account IDs");

  section("=== The ledger endpoint now accepts multiple account IDs at once ===");
  const combinedRes = await (await ledgerMod.onRequestGet({ request: getReq("ledger", "?account_ids=" + pnlRes.cogs_account_ids.join(",")), env })).json();
  const separateRes1 = await (await ledgerMod.onRequestGet({ request: getReq("ledger", "?account_id=" + pnlRes.cogs_account_ids[0]), env })).json();
  const separateRes2 = await (await ledgerMod.onRequestGet({ request: getReq("ledger", "?account_id=" + pnlRes.cogs_account_ids[1]), env })).json();
  assert(combinedRes.entries.length === separateRes1.entries.length + separateRes2.entries.length, "CRITICAL: querying both COGS accounts together returns exactly the combined entries of both queried separately");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
