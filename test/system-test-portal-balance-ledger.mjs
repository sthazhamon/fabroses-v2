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

async function run() {
  section("=== Setup: a reseller with a billed sale and a partial payment ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const partiesMod = await import("../functions/api/parties.js");
  const salesMod = await import("../functions/api/sales.js");
  const paymentsMod = await import("../functions/api/payments.js");
  const portalMod = await import("../functions/api/reseller-portal.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });

  const reseller = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy Resellers", type: "reseller" }), env })).json();
  const sale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 5000 }], customer_party_id: reseller.id, customer_name: null }), env, data: {} })).json();
  await paymentsMod.onRequestPost({ request: req({ party_id: reseller.id, direction: "receivable", amount: 2000, allocations: [{ bill_type: "sale", bill_id: sale.id, amount_applied: 2000 }] }), env, data: {} });

  section("=== The portal now shows the genuine outstanding balance ===");
  const portalRes = await (await portalMod.onRequestGet({ env, data: { user: { role: "reseller", resellerPartyId: reseller.id } } })).json();
  assert(portalRes.outstanding_balance === 3000, "CRITICAL: outstanding balance correctly reflects 5000 billed minus 2000 paid");

  section("=== The portal shows their own ledger history ===");
  assert(Array.isArray(portalRes.ledger_entries) && portalRes.ledger_entries.length > 0, "the portal correctly includes real ledger entries");
  const totalDebit = portalRes.ledger_entries.reduce((s, e) => s + (e.debit || 0), 0);
  assert(totalDebit === 5000, "the ledger entries correctly reflect the 5000 sale as a debit");

  section("=== A different reseller with no activity correctly shows zero ===");
  const otherReseller = await (await partiesMod.onRequestPost({ request: req({ name: "Other Resellers", type: "reseller" }), env })).json();
  const otherPortalRes = await (await portalMod.onRequestGet({ env, data: { user: { role: "reseller", resellerPartyId: otherReseller.id } } })).json();
  assert(otherPortalRes.outstanding_balance === 0, "CRITICAL: a reseller with no activity correctly shows zero outstanding balance");
  assert(otherPortalRes.ledger_entries.length === 0, "CRITICAL: their ledger correctly shows nothing - no cross-contamination");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
