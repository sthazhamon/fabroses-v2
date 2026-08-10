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
  section("=== Setup: a customer with two unpaid sales ===");
  const partiesMod = await import("../functions/api/parties.js");
  const salesMod = await import("../functions/api/sales.js");
  const anu = await (await partiesMod.onRequestPost({ request: req({ name: "Anu", type: "customer" }), env })).json();
  const sale1 = await (await salesMod.onRequestPost({ request: req({ lines: [{ description: "Sale 1", sale_price: 1000 }], customer_party_id: anu.id }), env, data: {} })).json();
  const sale2 = await (await salesMod.onRequestPost({ request: req({ lines: [{ description: "Sale 2", sale_price: 2000 }], customer_party_id: anu.id }), env, data: {} })).json();

  section("=== Outstanding bills lists both, correctly ===");
  const outstandingMod = await import("../functions/api/outstanding-bills.js");
  const outstanding1 = await (await outstandingMod.onRequestGet({ request: { url: `https://x/api/outstanding-bills?party_id=${anu.id}&direction=receivable` }, env })).json();
  assert(outstanding1.bills.length === 2, "both unpaid sales show as outstanding");

  section("=== Partial payment against ONE specific bill ===");
  const paymentsMod = await import("../functions/api/payments.js");
  const pay1 = await (await paymentsMod.onRequestPost({
    request: req({ party_id: anu.id, direction: "receivable", amount: 400, allocations: [{ bill_type: "sale", bill_id: sale1.id, amount_applied: 400 }] }), env, data: { user: {} },
  })).json();
  assert(pay1.unallocated === 0, "the full 400 was allocated, nothing left over");

  const outstanding2 = await (await outstandingMod.onRequestGet({ request: { url: `https://x/api/outstanding-bills?party_id=${anu.id}&direction=receivable` }, env })).json();
  const sale1Outstanding = outstanding2.bills.find((b) => b.bill_id === sale1.id);
  assert(sale1Outstanding.outstanding === 600, `sale1's outstanding correctly dropped from 1000 to 600 (got ${sale1Outstanding.outstanding})`);

  section("=== Bulk payment across BOTH bills in one action ===");
  const pay2 = await (await paymentsMod.onRequestPost({
    request: req({
      party_id: anu.id, direction: "receivable", amount: 2000,
      allocations: [{ bill_type: "sale", bill_id: sale1.id, amount_applied: 600 }, { bill_type: "sale", bill_id: sale2.id, amount_applied: 1400 }],
    }), env, data: {},
  })).json();
  assert(pay2.unallocated === 0, "bulk payment fully allocated across both bills");

  const outstanding3 = await (await outstandingMod.onRequestGet({ request: { url: `https://x/api/outstanding-bills?party_id=${anu.id}&direction=receivable` }, env })).json();
  assert(outstanding3.bills.length === 1 && outstanding3.bills[0].bill_id === sale2.id && outstanding3.bills[0].outstanding === 600,
    `sale1 is now fully paid and gone from the list; sale2 shows 600 still outstanding (2000-1400) (got ${JSON.stringify(outstanding3.bills)})`);

  section("=== Overpayment becomes an unattached advance, not an error ===");
  const pay3 = await (await paymentsMod.onRequestPost({
    request: req({ party_id: anu.id, direction: "receivable", amount: 1000, allocations: [{ bill_type: "sale", bill_id: sale2.id, amount_applied: 600 }] }), env, data: {},
  })).json();
  assert(pay3.unallocated === 400, `paying 1000 against a bill that only needed 600 correctly leaves 400 unallocated (got ${pay3.unallocated})`);

  const parties = await (await partiesMod.onRequestGet({ env })).json();
  const anuAfter = parties.find((p) => p.id === anu.id);
  // Total billed across both sales: 1000+2000=3000. Total paid across all three payments: 400+2000+1000=3400.
  // Anu genuinely overpaid by 400 in aggregate — a NEGATIVE balance is the correct representation of that advance (we owe her), not zero.
  assert(anuAfter.balance === -400, `Anu's balance correctly shows -400 — a genuine 400 advance, since she's paid 3400 total against 3000 billed (got ${anuAfter.balance})`);

  const outstanding4 = await (await outstandingMod.onRequestGet({ request: { url: `https://x/api/outstanding-bills?party_id=${anu.id}&direction=receivable` }, env })).json();
  assert(outstanding4.bills.length === 0, "both bills are now fully settled");

  section("=== Allocations can't exceed the payment amount ===");
  const badPay = await (await paymentsMod.onRequestPost({
    request: req({ party_id: anu.id, direction: "receivable", amount: 100, allocations: [{ bill_type: "sale", bill_id: sale2.id, amount_applied: 500 }] }), env, data: {},
  })).json();
  assert(badPay.error, "allocating more than the actual payment amount is rejected");

  section("=== Worker payments run through the exact same mechanism ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsModForWO = await import("../functions/api/items.js");
  const woMod = await import("../functions/api/work-orders.js");
  const site = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const woItem = await (await itemsModForWO.onRequestPost({ request: req({ item_type: "finished_good", name: "Test Item" }), env })).json();
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: site.id, intended_item_id: woItem.id, target_quantity: 1 }), env })).json();
  await env.DB.prepare("UPDATE work_orders SET closed_at = datetime('now'), labor_cost = 500 WHERE id = ?").bind(wo.id).run();

  const workerOutstanding = await (await outstandingMod.onRequestGet({ request: { url: `https://x/api/outstanding-bills?party_id=${site.worker_party_id}&direction=worker` }, env })).json();
  assert(workerOutstanding.bills.length === 1 && workerOutstanding.bills[0].outstanding === 500, "the closed work order's labor cost shows as an outstanding worker bill");

  const workerPay = await (await paymentsMod.onRequestPost({
    request: req({ party_id: site.worker_party_id, direction: "worker", amount: 500, allocations: [{ bill_type: "work_order", bill_id: wo.id, amount_applied: 500 }] }), env, data: {},
  })).json();
  assert(workerPay.unallocated === 0, "worker payment fully allocated against the specific work order");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
