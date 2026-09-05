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
function fileReq(f) { return { formData: async () => ({ get: (k) => (k === "photo" ? f : null) }) }; }
const fakeFile = { type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(8) };

async function run() {
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  const stageMod = await import("../functions/api/work-orders/[id]/stage.js");
  const markDoneMod = await import("../functions/api/work-orders/[id]/mark-done.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const dispatchPhotoMod = await import("../functions/api/dispatches/[id]/photo.js");
  const dispatchDetailMod = await import("../functions/api/dispatches/[id].js");
  const historyMod = await import("../functions/api/item-lots/[id]/history.js");
  const movementsMod = await import("../functions/api/movements.js").catch(() => null);
  const paymentsMod = await import("../functions/api/payments.js");
  const expensesMod = await import("../functions/api/expenses.js");
  const refundsMod = await import("../functions/api/refunds.js");
  const supplierBillsMod = await import("../functions/api/supplier-bills.js");
  const { createSale } = await import("../functions/api/_sales.js");
  const accountsMod = await import("../functions/api/accounts.js");
  const partiesMod = await import("../functions/api/parties.js");

  // =====================================================================
  // PART 1 — Multi-hop material movement, stable lot numbers, and scan
  // (item_code + origin lot) resolution, all traced end to end.
  // =====================================================================
  section("=== Setup: raw material intake at the store — this lot's number is what a QR label would encode forever ===");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Main Store", site_type: "store", address: "Store Rd", phone: "111" }), env })).json();
  const workerA = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker", address: "Zakir St", phone: "222" }), env })).json();
  const workerB = await (await sitesMod.onRequestPost({ request: req({ name: "Anwar", site_type: "worker", address: "Anwar St", phone: "333" }), env })).json();
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota Fabric" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Saree", item_code: "WEB-PEACOCK-01" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: rawItem.id, quantity_required: 2 }] }), env, params: { id: finishedItem.id } });

  const originLot = await (await lotsMod.onRequestPost({ request: req({ item_id: rawItem.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();
  const stableLotNumber = originLot.id;

  section("=== Hop 1: store → workerA, scanned by item_code (as a generic phone scan would produce) ===");
  const dispatch1 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: workerA.id, items: [{ item_id: rawItem.id, lot_id: originLot.id, expected_quantity: 10 }] });
  const pick1 = await confirmPick(env, dispatch1, { item_id: rawItem.id, lot_id: originLot.id, scanned_quantity: 10 });
  assert(!pick1.error, `hop 1 pick succeeds, got ${pick1.error}`);
  await shipDispatch(env, dispatch1, { courier: "Internal" }, "store staff");
  const photoOnDispatch1 = await (await dispatchPhotoMod.onRequestPost({ request: fileReq(fakeFile), env, params: { id: dispatch1 } })).json();
  assert(photoOnDispatch1.ok, "a photo can be attached mid-movement on hop 1's dispatch");
  const di1 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatch1).first();
  await confirmReceive(env, dispatch1, [{ dispatch_item_id: di1.id, received_quantity: 10 }], "Zakir");
  const lotAtA = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ?").bind(rawItem.id, workerA.id).first();
  assert(lotAtA.id !== stableLotNumber, "the lot at workerA correctly has a NEW id, distinct from the original");
  assert(lotAtA.origin_lot_id === stableLotNumber, "but its origin correctly traces back to the original stable number");

  section("=== Hop 2: workerA → workerB, scanned using the ORIGINAL stable number (not the current lot id) ===");
  const dispatch2 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: workerA.id, to_site_id: workerB.id, items: [{ item_id: rawItem.id, lot_id: lotAtA.id, expected_quantity: 10 }] });
  const pick2 = await confirmPick(env, dispatch2, { item_id: rawItem.id, lot_id: stableLotNumber, scanned_quantity: 10 });
  assert(!pick2.error, `CRITICAL: scanning the ORIGINAL lot number two hops later still resolves correctly, got ${pick2.error}`);
  assert(!pick2.mismatch, "and is correctly not flagged as a mismatch");
  await shipDispatch(env, dispatch2, {}, "Zakir");
  const di2 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatch2).first();
  await confirmReceive(env, dispatch2, [{ dispatch_item_id: di2.id, received_quantity: 10, scanned_item_id: rawItem.id, scanned_lot_id: stableLotNumber }], "Anwar");
  const lotAtB = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ?").bind(rawItem.id, workerB.id).first();
  assert(lotAtB.origin_lot_id === stableLotNumber, "the lot now at workerB (third distinct lot id) STILL correctly traces to the same original origin");

  section("=== Dispatch photo scoping: hop 1's photo doesn't leak onto hop 2's dispatch ===");
  const dispatch1Detail = await (await dispatchDetailMod.onRequestGet({ params: { id: dispatch1 }, env })).json();
  const dispatch2Detail = await (await dispatchDetailMod.onRequestGet({ params: { id: dispatch2 }, env })).json();
  assert(dispatch1Detail.photos.length === 1, "dispatch 1 correctly still has its own photo");
  assert(dispatch2Detail.photos.length === 0, "dispatch 2 correctly has none — no cross-contamination between dispatches");
  assert(dispatch1Detail.from_site_address === "Store Rd" && dispatch1Detail.to_site_address === "Zakir St", "hop 1's from/to addresses resolve correctly");
  assert(dispatch2Detail.from_site_address === "Zakir St" && dispatch2Detail.to_site_address === "Anwar St", "hop 2's from/to addresses resolve independently and correctly");

  section("=== Work order at workerB: issue from the material now on-site, verify by item_code ===");
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Peacock job", worker_site_id: workerB.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env })).json();
  assert(!!wo.id, "WO creation succeeds now that a BOM exists");
  await issueMod.onRequestPost({ request: req({ lot_id: lotAtB.id, quantity: 4 }), env, params: { id: wo.id } });
  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).first();
  const verifyRes = await (await verifyMod.onRequestPost({ request: req({ item_id: rawItem.id, lot_id: issue.lot_id }), env, params: { id: issue.id } })).json();
  assert(verifyRes.ok, "material verify against the current on-site lot succeeds");

  const stageRes = await (await stageMod.onRequestPost({ request: req({ stage: "Work Started", changed_by: "Anwar" }), env, params: { id: wo.id } })).json();
  assert(stageRes.ok, "work can start now that the material is verified");

  const doneRes = await (await markDoneMod.onRequestPost({ request: req({ labor_cost: 200 }), env, params: { id: wo.id }, data: { user: { name: "admin" } } })).json();
  assert(doneRes.ok, `mark job done succeeds, got ${JSON.stringify(doneRes)}`);
  assert(doneRes.raw_material_consumed.length === 1 && Math.abs(doneRes.raw_material_consumed[0].consumed - 2) < 0.001, "exactly the BOM-required 2 units were consumed, not the full 4 issued");

  section("=== Lot history for the ORIGINAL stable number shows the complete, consistent chain ===");
  const lotHistory = await (await historyMod.onRequestGet({ params: { id: stableLotNumber }, env })).json();
  const historyEvents = lotHistory.movements || lotHistory.events || lotHistory;
  const historyStr = JSON.stringify(historyEvents);
  assert(historyStr.includes(workerA.id) && historyStr.includes(workerB.id), "the origin lot's history correctly shows movement through BOTH worker sites");

  // =====================================================================
  // PART 2 — Global ledger consistency across every payment-account flow
  // touched this session: payments, expenses, refunds, supplier bills,
  // and walk-in sales, mixing custom accounts, Cash, and Bank.
  // =====================================================================
  section("=== Setting up two custom accounts and a customer/supplier ===");
  const bankA = await (await accountsMod.onRequestPost({ request: req({ name: "Bank A" }), env })).json();
  const pettyCashB = await (await accountsMod.onRequestPost({ request: req({ name: "Petty Cash B" }), env })).json();
  const customer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer" }), env })).json();
  const supplier = await (await partiesMod.onRequestPost({ request: req({ name: "Yarn Supplier", type: "supplier" }), env })).json();

  section("=== Recording one of each kind of money movement, through different accounts ===");
  const sale1 = await createSale(env, { lines: [{ item_id: finishedItem.id, description: "Walk-in", quantity: 1, sale_price: 2000 }], account_id: bankA.id, created_by: "cashier" });
  assert(!!sale1.id, "walk-in sale via Bank A succeeds");

  const refund1 = await (await refundsMod.onRequestPost({ request: req({ sale_id: sale1.id, amount: 200, account_id: pettyCashB.id, reason: "Partial dissatisfaction" }), env, data: { user: {} } })).json();
  assert(!!refund1.id, "cash refund via Petty Cash B succeeds");

  const expCatRes = await env.DB.prepare("INSERT INTO expense_categories (name) VALUES ('Consistency Test Rent')").run();
  const expense1 = await (await expensesMod.onRequestPost({ request: req({ description: "Rent", expense_category_id: expCatRes.meta.last_row_id, amount: 500, account_id: bankA.id }), env, data: { user: {} } })).json();
  assert(!!expense1.id, "expense via Bank A succeeds");

  const bill1 = await (await supplierBillsMod.onRequestPost({ request: req({ supplier_name: "Cash purchase", lines: [{ item_id: rawItem.id, quantity: 5, rate: 100 }] }), env, data: { user: {} } })).json();
  assert(!!bill1.id, "cash supplier bill (default account) succeeds");

  const payment1 = await (await paymentsMod.onRequestPost({ request: req({ party_id: supplier.id, direction: "payable", amount: 300, account_id: pettyCashB.id, allocations: [] }), env, data: { user: {} } })).json();
  assert(!!payment1.id, "payable payment via Petty Cash B succeeds");

  const receivablePayment = await (await paymentsMod.onRequestPost({ request: req({ party_id: customer.id, direction: "receivable", amount: 1000, allocations: [] }), env, data: { user: {} } })).json();
  assert(!!receivablePayment.id, "receivable payment with NO account chosen (default Cash) succeeds");

  section("=== CRITICAL: the whole ledger still balances globally after this mix ===");
  const totals = await env.DB.prepare("SELECT SUM(debit) AS total_debit, SUM(credit) AS total_credit FROM journal_lines").first();
  assert(Math.abs(totals.total_debit - totals.total_credit) < 0.01, `CRITICAL: total debits (${totals.total_debit}) equal total credits (${totals.total_credit}) across the ENTIRE journal after every account-selection flow touched this session`);

  section("=== And each individual account's own ledger correctly reflects only what actually went through it ===");
  const bankATotals = await env.DB.prepare("SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines WHERE account_id = ?").bind(bankA.id).first();
  // Bank A: debited 2000 (sale) + debited 500 (expense's underlying account is credited, not debited — expense debits the EXPENSE account and credits cash/bank)
  assert(bankATotals.d === 2000, `Bank A was debited exactly the 2000 walk-in sale receipt, got ${bankATotals.d}`);
  assert(bankATotals.c === 500, `Bank A was credited exactly the 500 expense payout, got ${bankATotals.c}`);
  const pettyCashTotals = await env.DB.prepare("SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines WHERE account_id = ?").bind(pettyCashB.id).first();
  assert(pettyCashTotals.d === 0, `Petty Cash B correctly had nothing debited into it in this scenario, got ${pettyCashTotals.d}`);
  assert(pettyCashTotals.c === 500, `Petty Cash B was correctly credited 200 (refund payout) + 300 (payable payment) = 500 as cash went OUT both times, got ${pettyCashTotals.c}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
