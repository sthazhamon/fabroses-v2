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
  section("=== Setup: a reseller and a finished good in stock ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const partiesMod = await import("../functions/api/parties.js");
  const salesMod = await import("../functions/api/sales.js");
  const paymentsMod = await import("../functions/api/payments.js");
  const gamificationMod = await import("../functions/api/_gamification.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });
  const reseller = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy Resellers", type: "reseller" }), env })).json();
  const plainCustomer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer" }), env })).json();

  section("=== Points are NOT earned at billing time, only once fully paid ===");
  const sale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 1000 }], customer_party_id: reseller.id, customer_name: null }), env, data: { user: { name: "Admin" } } })).json();

  const balanceAfterBilling = await gamificationMod.getSpendableBalance(env, reseller.id);
  assert(balanceAfterBilling === 0, "CRITICAL: no points are earned just from billing, even though the sale exists - got " + balanceAfterBilling);

  section("=== A partial payment does not yet earn points ===");
  const partialPaymentRes = await (await paymentsMod.onRequestPost({
    request: req({ party_id: reseller.id, direction: "receivable", amount: 400, allocations: [{ bill_type: "sale", bill_id: sale.id, amount_applied: 400 }] }), env, data: { user: { name: "Admin" } },
  })).json();
  assert(partialPaymentRes.points_awards.length === 0, "a partial payment (400 of 1000) correctly earns no points yet");

  section("=== Once fully paid, points are earned proportional to the order value ===");
  const finalPaymentRes = await (await paymentsMod.onRequestPost({
    request: req({ party_id: reseller.id, direction: "receivable", amount: 600, allocations: [{ bill_type: "sale", bill_id: sale.id, amount_applied: 600 }] }), env, data: { user: { name: "Admin" } },
  })).json();
  assert(finalPaymentRes.points_awards.length === 1, "the final payment correctly triggers a points award, now that the sale is fully paid");
  assert(finalPaymentRes.points_awards[0].points_earned === 1000, "CRITICAL: points earned correctly match the default rate (1 point per rupee) x order value (1000), got " + finalPaymentRes.points_awards[0].points_earned);

  const balanceAfterFull = await gamificationMod.getSpendableBalance(env, reseller.id);
  assert(balanceAfterFull === 1000, "the reseller's spendable balance correctly reflects the earned points");

  section("=== Points are never double-awarded for the same sale ===");
  const extraPaymentRes = await (await paymentsMod.onRequestPost({
    request: req({ party_id: reseller.id, direction: "receivable", amount: 0, allocations: [{ bill_type: "sale", bill_id: sale.id, amount_applied: 0 }] }), env, data: {},
  })).json();
  assert(extraPaymentRes.points_awards.length === 0, "attempting to trigger the same already-fully-paid sale again correctly awards nothing further");

  const balanceStillSame = await gamificationMod.getSpendableBalance(env, reseller.id);
  assert(balanceStillSame === 1000, "the balance remains unchanged, confirming no double-award happened");

  section("=== A plain customer (not a reseller) never earns points at all ===");
  const plainSale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 500 }], customer_party_id: plainCustomer.id, customer_name: null }), env, data: { user: { name: "Admin" } } })).json();
  const plainPaymentRes = await (await paymentsMod.onRequestPost({
    request: req({ party_id: plainCustomer.id, direction: "receivable", amount: 500, allocations: [{ bill_type: "sale", bill_id: plainSale.id, amount_applied: 500 }] }), env, data: {},
  })).json();
  assert(plainPaymentRes.points_awards.length === 0, "a plain customer's fully-paid sale correctly earns no points at all");

  section("=== A custom points-per-rupee rate is correctly respected ===");
  await gamificationMod.setPointsPerRupee(env, 2);
  const sale2 = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 300 }], customer_party_id: reseller.id, customer_name: null }), env, data: { user: { name: "Admin" } } })).json();
  const paymentRes2 = await (await paymentsMod.onRequestPost({
    request: req({ party_id: reseller.id, direction: "receivable", amount: 300, allocations: [{ bill_type: "sale", bill_id: sale2.id, amount_applied: 300 }] }), env, data: {},
  })).json();
  assert(paymentRes2.points_awards[0].points_earned === 600, "CRITICAL: at a custom rate of 2 points per rupee, 300 correctly earns 600 points, got " + paymentRes2.points_awards[0].points_earned);

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
