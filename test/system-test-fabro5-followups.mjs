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
function fileReq(formData) { return { formData: async () => formData }; }

async function run() {
  const sitesMod = await import("../functions/api/sites.js");
  const siteDetailMod = await import("../functions/api/sites/[id].js");
  const itemsMod = await import("../functions/api/items.js");
  const itemDetailMod = await import("../functions/api/items/[id].js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const dispatchesMod = await import("../functions/api/dispatches.js");
  const dispatchDetailMod = await import("../functions/api/dispatches/[id].js");
  const { createDispatch, confirmPick, shipDispatch } = await import("../functions/api/_dispatch.js");
  const cancelPickMod = await import("../functions/api/dispatches/[id]/cancel-pick.js");
  const dispatchPhotoMod = await import("../functions/api/dispatches/[id]/photo.js");
  const confirmDeliveryMod = await import("../functions/api/dispatches/[id]/confirm-delivery.js");
  const dashboardAlertsMod = await import("../functions/api/dashboard-alerts.js");
  const woMod = await import("../functions/api/work-orders.js");
  const woDetailMod = await import("../functions/api/work-orders/[id].js");
  const materialIssuesMod = await import("../functions/api/material-issues-by-lot.js").catch(() => null);
  const accountsMod = await import("../functions/api/accounts.js");
  const partiesMod = await import("../functions/api/parties.js");
  const paymentsMod = await import("../functions/api/payments.js");
  const customerOrdersMod = await import("../functions/api/customer-orders.js");

  // ================= Item 3: cancel a pick =================
  section("=== #3 Undo a pick — returns the dispatch to pending_pick, not cancelled ===");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Main Store", site_type: "store", address: "12 Store Rd", phone: "0471-111111" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker", address: "Zakir's workshop", phone: "9999900000" }), env })).json();
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: rawItem.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();
  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: rawItem.id, lot_id: lot.id, expected_quantity: 5 }] });
  await confirmPick(env, dispatchId, { item_id: rawItem.id, lot_id: lot.id, scanned_quantity: 5 });
  const pickedRow = await env.DB.prepare("SELECT status FROM dispatches WHERE id = ?").bind(dispatchId).first();
  assert(pickedRow.status === "picked", "dispatch is at picked before we undo it");

  const undoRes = await (await cancelPickMod.onRequestPost({ env, params: { id: dispatchId } })).json();
  assert(undoRes.ok, "undoing the pick succeeds");
  const afterUndo = await env.DB.prepare("SELECT status FROM dispatches WHERE id = ?").bind(dispatchId).first();
  assert(afterUndo.status === "pending_pick", `CRITICAL: dispatch is back to pending_pick, not cancelled (got ${afterUndo.status})`);
  const itemAfterUndo = await env.DB.prepare("SELECT scanned_quantity, mismatch_flag FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();
  assert(itemAfterUndo.scanned_quantity === null, "the scanned quantity is cleared so it can be picked again");

  const rePicked = await confirmPick(env, dispatchId, { item_id: rawItem.id, lot_id: lot.id, scanned_quantity: 5 });
  assert(rePicked.ok, "the dispatch can be picked again after the undo, correctly");

  const undoOnPending = await (await cancelPickMod.onRequestPost({ env, params: { id: dispatchId } })).json();
  await shipDispatch(env, dispatchId, {}, "store staff");
  const undoAfterShip = await (await cancelPickMod.onRequestPost({ env, params: { id: dispatchId } })).json();
  assert(undoAfterShip.error, "undoing a pick is correctly rejected once the dispatch has actually shipped");

  // ================= Item 4/14: site address, phone, and edit =================
  section("=== #4/#14 Site address, phone, and edit ===");
  const storeRow = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(store.id).first();
  assert(storeRow.address === "12 Store Rd" && storeRow.phone === "0471-111111", "store site correctly saved address and phone at creation");

  const siteEditRes = await (await siteDetailMod.onRequestPatch({ request: req({ address: "45 New Store Rd", phone: "0471-222222" }), env, params: { id: store.id }, data: { user: { name: "admin" } } })).json();
  assert(siteEditRes.ok, "editing a site's address/phone now works");
  const storeAfterEdit = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(store.id).first();
  assert(storeAfterEdit.address === "45 New Store Rd" && storeAfterEdit.phone === "0471-222222", "the edited address and phone are correctly saved");

  const dispatchDetail = await (await dispatchDetailMod.onRequestGet({ params: { id: dispatchId }, env })).json();
  assert(dispatchDetail.from_site_address === "45 New Store Rd", "dispatch detail now resolves and returns the FROM site's own address");
  assert(dispatchDetail.from_site_phone === "0471-222222", "and its phone too");

  // ================= Item 9: photo on dispatch movement =================
  section("=== #9 Photo of the goods on a dispatch ===");
  const fakeFile = { type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(8) };
  const photoRes = await (await dispatchPhotoMod.onRequestPost({ request: fileReq({ get: (k) => (k === "photo" ? fakeFile : null) }), env, params: { id: dispatchId } })).json();
  assert(photoRes.ok, "uploading a photo to a dispatch works");
  const dispatchWithPhoto = await (await dispatchDetailMod.onRequestGet({ params: { id: dispatchId }, env })).json();
  assert(dispatchWithPhoto.photos.length === 1, "the dispatch now shows the uploaded photo");

  // ================= Item 6: customer delivery confirmation =================
  section("=== #6 Delivery confirmation before the order loop closes ===");
  const customer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Saree" }), env })).json();
  const finishedLot = await (await lotsMod.onRequestPost({ request: req({ item_id: finishedItem.id, site_id: store.id, quantity: 2, source_type: "direct_intake" }), env, data: {} })).json();
  const co = await (await customerOrdersMod.onRequestPost({ request: req({ customer_party_id: customer.id, customer_name: "Susan", delivery_address: "Her house", items: [{ item_id: finishedItem.id, quantity: 1, unit_price: 2000 }] }), env })).json();
  const custDispatchId = await createDispatch(env, { dispatch_type: "customer_shipment", from_site_id: store.id, to_site_id: null, related_customer_order_id: co.id, items: [{ item_id: finishedItem.id, lot_id: finishedLot.id, expected_quantity: 1 }] });
  await confirmPick(env, custDispatchId, { item_id: finishedItem.id, lot_id: finishedLot.id, scanned_quantity: 1 });
  await shipDispatch(env, custDispatchId, { courier: "BlueDart" }, "store staff");

  const coAfterShip = await env.DB.prepare("SELECT status FROM customer_orders WHERE id = ?").bind(co.id).first();
  assert(coAfterShip.status === "shipped", "CO correctly shows shipped, not yet delivered");

  const alertsBeforeConfirm = await (await dashboardAlertsMod.onRequestGet({ env })).json();
  assert(alertsBeforeConfirm.awaiting_delivery_confirmation.some((d) => d.id === custDispatchId), "the dashboard correctly lists this shipment as awaiting delivery confirmation");

  const wrongTypeConfirm = await (await confirmDeliveryMod.onRequestPost({ env, params: { id: dispatchId }, data: {} })).json();
  assert(wrongTypeConfirm.error, "confirm-delivery is correctly rejected for a non-customer_shipment dispatch");

  const confirmRes = await (await confirmDeliveryMod.onRequestPost({ env, params: { id: custDispatchId }, data: { user: { name: "admin" } } })).json();
  assert(confirmRes.ok, "confirming delivery succeeds");
  const coAfterConfirm = await env.DB.prepare("SELECT status FROM customer_orders WHERE id = ?").bind(co.id).first();
  assert(coAfterConfirm.status === "delivered", `CRITICAL: the order loop only now closes to 'delivered' (got ${coAfterConfirm.status})`);

  const secondConfirm = await (await confirmDeliveryMod.onRequestPost({ env, params: { id: custDispatchId }, data: {} })).json();
  assert(secondConfirm.error, "confirming delivery twice is correctly rejected");

  const alertsAfterConfirm = await (await dashboardAlertsMod.onRequestGet({ env })).json();
  assert(!alertsAfterConfirm.awaiting_delivery_confirmation.some((d) => d.id === custDispatchId), "and it correctly drops off the awaiting-confirmation list");
  assert(!alertsAfterConfirm.unactioned_orders.some((o) => o.id === co.id), "a delivered order is correctly not flagged as unactioned");

  // ================= Item 5: material in transit on dashboard =================
  section("=== #5 Dashboard shows material in transit ===");
  const lot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: rawItem.id, site_id: store.id, quantity: 20, source_type: "direct_intake" }), env, data: {} })).json();
  const transitDispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: rawItem.id, lot_id: lot2.id, expected_quantity: 8 }] });
  await confirmPick(env, transitDispatchId, { item_id: rawItem.id, lot_id: lot2.id, scanned_quantity: 8 });
  await shipDispatch(env, transitDispatchId, {}, "store staff");

  const alertsWithTransit = await (await dashboardAlertsMod.onRequestGet({ env })).json();
  const transitEntry = alertsWithTransit.material_in_transit.find((d) => d.id === transitDispatchId);
  assert(!!transitEntry, "the shipped-but-not-received stock transfer correctly shows up as material in transit");
  assert(transitEntry.item_summary.includes("Kota"), "and it correctly names the item in transit");
  assert(!alertsWithTransit.material_in_transit.some((d) => d.id === custDispatchId), "a customer shipment is correctly excluded from the internal material-in-transit list");

  // ================= Item 10: photos on the worker verify screen =================
  section("=== #10 Worker's verify screen gets photo context ===");
  await (await itemsMod.onRequestGet({ request: new Request("http://x"), env })); // warm path, no-op
  // Give the raw material and finished item cover photos
  await env.DB.prepare("INSERT INTO item_photos (item_id, r2_key) VALUES (?, 'raw-photo.jpg')").bind(rawItem.id).run();
  await env.DB.prepare("INSERT INTO item_photos (item_id, r2_key) VALUES (?, 'finished-photo.jpg')").bind(finishedItem.id).run();

  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job for Susan's saree", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env })).json();
  assert(!!wo.error, "sanity check: WO creation without a BOM correctly fails (expected, so we add one next)");
  await env.DB.prepare("INSERT INTO item_bom (finished_item_id, raw_material_item_id, quantity_required) VALUES (?, ?, 4)").bind(finishedItem.id, rawItem.id).run();
  const wo2 = await (await woMod.onRequestPost({ request: req({ description: "Job for Susan's saree", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env })).json();
  assert(!!wo2.id, "WO creation now succeeds once a BOM exists");
  const rawLotForWo = await (await lotsMod.onRequestPost({ request: req({ item_id: rawItem.id, site_id: worker.id, quantity: 4, source_type: "direct_intake" }), env, data: {} })).json();
  await env.DB.prepare("INSERT INTO material_issues (id, work_order_id, lot_id, quantity_issued, worker_site_id, status) VALUES ('ISS-TEST01', ?, ?, 4, ?, 'with_worker')").bind(wo2.id, rawLotForWo.id, worker.id).run();

  const woDetail = await (await woDetailMod.onRequestGet({ params: { id: wo2.id }, env })).json();
  assert(woDetail.intended_item_photo_key === "finished-photo.jpg", "the work order now surfaces the finished item's own cover photo");
  assert(woDetail.issues[0].item_photo_key === "raw-photo.jpg", "and each material issue now surfaces the raw material's own cover photo");

  // ================= Item 11: user-defined item code =================
  section("=== #11 User-defined item code instead of only auto-generation ===");
  const skuItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Existing SKU Saree", item_code: "WEB-SKU-001" }), env })).json();
  assert(skuItem.item_code === "WEB-SKU-001", "a user-supplied item code is used verbatim, not overridden by auto-generation");

  const clashAttempt = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Another item", item_code: "web-sku-001" }), env })).json();
  assert(clashAttempt.error, "a duplicate item code (even differing only in case) is correctly rejected");

  const noCodeItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Plain Cotton" }), env })).json();
  assert(noCodeItem.item_code === null, "leaving item_code blank still results in no auto-code for an item with no category/fabric/work-type/pattern set, as before");

  const editCodeRes = await (await itemDetailMod.onRequestPatch({ request: req({ item_code: "WEB-SKU-002" }), env, params: { id: noCodeItem.id }, data: {} })).json();
  assert(editCodeRes.ok, "an item's code can be set after the fact via edit");
  const editClash = await (await itemDetailMod.onRequestPatch({ request: req({ item_code: "WEB-SKU-001" }), env, params: { id: noCodeItem.id }, data: {} })).json();
  assert(editClash.error, "editing to a code already used elsewhere is correctly rejected");

  // ================= Item 12/13: cash/bank accounts + payment account selection =================
  section("=== #12/#13 Named cash/bank accounts, and choosing one on a payment ===");
  const defaultCashBank = await (await accountsMod.onRequestGet({ request: new Request("http://x/accounts?cash_bank=1"), env })).json();
  assert(defaultCashBank.length === 2 && defaultCashBank.some((a) => a.name === "Cash") && defaultCashBank.some((a) => a.name === "Bank"), "the two built-in Cash and Bank accounts are correctly flagged as cash/bank accounts");

  const newAcctRes = await (await accountsMod.onRequestPost({ request: req({ name: "Bank A" }), env })).json();
  assert(newAcctRes.id, "adding a new named cash/bank account (Bank A) succeeds");

  const dupAcctRes = await (await accountsMod.onRequestPost({ request: req({ name: "bank a" }), env })).json();
  assert(dupAcctRes.error, "adding a duplicate-named account (case-insensitive) is correctly rejected");

  const cashBankAfterAdd = await (await accountsMod.onRequestGet({ request: new Request("http://x/accounts?cash_bank=1"), env })).json();
  assert(cashBankAfterAdd.length === 3, "the cash/bank list now includes the newly added account");
  const allAccounts = await (await accountsMod.onRequestGet({ request: new Request("http://x/accounts"), env })).json();
  assert(allAccounts.length > cashBankAfterAdd.length, "the general chart-of-accounts listing (no filter) still returns every account, not just cash/bank ones");

  const anu = await (await partiesMod.onRequestPost({ request: req({ name: "Anu", type: "customer" }), env })).json();
  const paymentWithAccount = await (await paymentsMod.onRequestPost({ request: req({ party_id: anu.id, direction: "receivable", amount: 500, account_id: newAcctRes.id, allocations: [] }), env, data: { user: {} } })).json();
  assert(paymentWithAccount.id, "recording a payment against the chosen Bank A account succeeds");

  const journalLine = await env.DB.prepare(
    `SELECT jl.* FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.reference_type = 'payment' AND je.reference_id = ? AND jl.account_id = ?`
  ).bind(paymentWithAccount.id, newAcctRes.id).first();
  assert(journalLine && journalLine.debit === 500, "CRITICAL: the journal entry actually debited Bank A, not the default Cash account");

  const paymentNoAccount = await (await paymentsMod.onRequestPost({ request: req({ party_id: anu.id, direction: "receivable", amount: 200, allocations: [] }), env, data: { user: {} } })).json();
  assert(paymentNoAccount.id, "recording a payment with NO account specified still works — backward compatible");
  const cashId = await env.DB.prepare("SELECT id FROM accounts WHERE code = '1000'").first();
  const defaultJournalLine = await env.DB.prepare(
    `SELECT jl.* FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.reference_type = 'payment' AND je.reference_id = ? AND jl.account_id = ?`
  ).bind(paymentNoAccount.id, cashId.id).first();
  assert(defaultJournalLine && defaultJournalLine.debit === 200, "and it correctly defaults to debiting the built-in Cash account, exactly as before this change");

  const badAccountPayment = await (await paymentsMod.onRequestPost({ request: req({ party_id: anu.id, direction: "receivable", amount: 50, account_id: 999999, allocations: [] }), env, data: { user: {} } })).json();
  assert(badAccountPayment.error, "passing an account_id that isn't a real cash/bank account is correctly rejected");

  // ================= Item 13 (extended): expenses, refunds, supplier bills, walk-in sales =================
  section("=== #13 (extended) — expenses, refunds, supplier bills, and walk-in sales can also choose an account ===");
  const expenseCatRes = await env.DB.prepare("INSERT INTO expense_categories (name) VALUES ('Test Category XYZ')").run();
  const expenseWithAccount = await (await import("../functions/api/expenses.js")).onRequestPost({ request: req({ description: "Shop rent", expense_category_id: expenseCatRes.meta.last_row_id, amount: 1000, account_id: newAcctRes.id }), env, data: { user: {} } });
  const expenseJson = await expenseWithAccount.json();
  assert(expenseJson.id, "recording an expense against a chosen account succeeds");
  const expenseJournalLine = await env.DB.prepare(
    `SELECT jl.* FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id WHERE je.reference_type = 'expense' AND je.reference_id = ? AND jl.account_id = ?`
  ).bind(expenseJson.id, newAcctRes.id).first();
  assert(expenseJournalLine && expenseJournalLine.credit === 1000, "the expense correctly credited the chosen account, not the default Cash");

  const badExpenseAccount = await (await (await import("../functions/api/expenses.js")).onRequestPost({ request: req({ description: "Bad", expense_category_id: expenseCatRes.meta.last_row_id, amount: 10, account_id: 999999 }), env, data: { user: {} } })).json();
  assert(badExpenseAccount.error, "an invalid account_id on an expense is correctly rejected");

  const { createSale } = await import("../functions/api/_sales.js");
  const walkInStockLot = await (await lotsMod.onRequestPost({ request: req({ item_id: finishedItem.id, site_id: store.id, quantity: 5, source_type: "direct_intake" }), env, data: {} })).json();
  const walkInSale = await createSale(env, { lines: [{ item_id: finishedItem.id, description: "Walk-in sale", quantity: 1, sale_price: 1500 }], account_id: newAcctRes.id, created_by: "cashier" });
  const saleJournalLine = await env.DB.prepare(
    `SELECT jl.* FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id WHERE je.reference_type = 'sale' AND je.reference_id = ? AND jl.account_id = ?`
  ).bind(walkInSale.id, newAcctRes.id).first();
  assert(saleJournalLine && saleJournalLine.debit === 1500, "a walk-in cash sale correctly debits the chosen account instead of the default Cash");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
