// True end-to-end test against the rebuilt backend + frontend. Real HTTP,
// real request bodies copied from the frontend's own JS functions.
// Run with: node test/frontend-integration-test-v2.mjs

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";
import { buildRouter, startServer } from "./router.mjs";

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${label}`); }
}
function section(title) { console.log(`\n${title}`); }

const PORT = 8992;
const BASE = `http://localhost:${PORT}/api`;
let token = null;

async function apiFetch(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(BASE + path, Object.assign({}, opts, { headers }));
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json;
}
function postJSON(body) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }
function patchJSON(body) { return { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

async function run() {
  const sqliteDb = new DatabaseSync(":memory:");
  sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };

  const router = await buildRouter(new URL("../functions/api", import.meta.url).pathname);
  const server = await startServer(router, env, PORT);
  console.log(`Test server listening on ${PORT}, routes loaded: ${router.routes.length}`);

  try {
    const { generateSalt, hashPin } = await import("../functions/api/_auth.js");
    const salt = generateSalt();
    const hash = await hashPin("adminpin123", salt);
    await env.DB.prepare("INSERT INTO users (name, username, pin_hash, pin_salt, role, token_version, active) VALUES ('Admin', 'admin', ?, ?, 'admin', 1, 1)").bind(hash, salt).run();

    section("=== Login ===");
    const loginRes = await fetch(BASE + "/auth/login", postJSON({ username: "admin", pin: "adminpin123" })).then((r) => r.json());
    assert(loginRes.token, "login succeeded");
    token = loginRes.token;

    section("=== Sites, Items, Parties — exact frontend field names ===");
    const store = await apiFetch("/sites", postJSON({ name: "Main Store", site_type: "store" }));
    const workerRes = await apiFetch("/sites", postJSON({ name: "Zakir", site_type: "worker" }));
    assert(workerRes.worker_party_id, "createSite() for a worker returns worker_party_id, matching frontend expectations");

    const rawItem = await apiFetch("/items", postJSON({ item_type: "raw_material", name: "Kota", category_id: null, fabric_id: null, work_type_id: null, pattern_id: null, unit_of_measure: "metre", color: "", price: null, cost: null, description: "" }));
    const finishedItem = await apiFetch("/items", postJSON({ item_type: "finished_good", name: "Test Saree", category_id: null, fabric_id: null, work_type_id: null, pattern_id: null, unit_of_measure: "piece", color: "", price: 5000, cost: null, description: "" }));
    const anu = await apiFetch("/parties", postJSON({ name: "Anu", type: "customer", opening_balance: 0 }));
    assert(anu.id, "createParty()'s field set accepted");

    section("=== Purchase Order -> receive -> Supplier Bill (PO track, now multi-line) ===");
    const po = await apiFetch("/purchase-orders", postJSON({ supplier_party_id: null, supplier_name: "Neelam Fabrics", items: [{ item_id: rawItem.id, quantity_ordered: 50, rate: 200 }], expected_date: null }));
    const poRow = (await apiFetch("/purchase-orders")).find((p) => p.id === po.id);
    const poLine = poRow.items[0];
    await apiFetch("/purchase-order-items/" + poLine.id + "/receive", postJSON({ quantity_received: 50 }));
    const sbRes = await apiFetch("/supplier-bills", postJSON({ purchase_order_id: po.id, supplier_party_id: null, supplier_name: "Neelam Fabrics", bill_number: "INV1", lines: [{ purchase_order_item_id: poLine.id, item_id: rawItem.id, quantity: 50, rate: 200 }], description: "" }));
    assert(sbRes.id, "createSupplierBill() (PO track, multi-line) accepted");

    section("=== Cash purchase track (no PO) ===");
    const cashBill = await apiFetch("/supplier-bills", postJSON({ purchase_order_id: null, supplier_party_id: null, supplier_name: "Cash purchase", bill_number: "", lines: [{ item_id: null, quantity: 1, rate: 200 }], description: "Buttons" }));
    assert(cashBill.id, "cash purchase (no PO) works as its own track");

    section("=== Work Order creation REQUIRES a worker (createWO()'s exact body) ===");
    const noWorkerRes = await fetch(BASE + "/work-orders", postJSON({ description: "Test", work_instructions: "", worker_site_id: "", intended_item_id: null, target_quantity: 1, priority: "normal", due_date: null })).then((r) => r.json());
    assert(noWorkerRes.error, "creating a WO with an empty worker_site_id is rejected, matching the mandatory-worker redesign");

    const wo = await apiFetch("/work-orders", postJSON({ description: "Embroidery job", work_instructions: "", worker_site_id: workerRes.id, intended_item_id: finishedItem.id, target_quantity: 2, priority: "normal", due_date: null, related_customer_order_id: null }));
    assert(wo.id, "createWO() with a real worker succeeds");

    section("=== Issue material -> pick -> ship -> confirm receive (full two-step, via frontend actions) ===");
    const lot = await apiFetch("/item-lots", postJSON({ item_id: rawItem.id, site_id: store.id, quantity: 30, source_type: "direct_intake", cost_total: 6000 }));
    const issueRes = await apiFetch("/work-orders/" + wo.id + "/issue-material", postJSON({ lot_id: lot.id, quantity: 10 }));
    assert(issueRes.dispatch_id, "issueMaterial()'s exact field names create a pending dispatch, not an immediate transfer");

    const dispDetail = await apiFetch("/dispatches/" + issueRes.dispatch_id);
    const dItem = dispDetail.items[0];
    await apiFetch("/dispatches/" + issueRes.dispatch_id + "/scan", postJSON({ item_id: dItem.item_id, lot_id: dItem.lot_id, scanned_quantity: 10 }));
    await apiFetch("/dispatches/" + issueRes.dispatch_id + "/ship", postJSON({ courier: "DTDC", tracking_id: "T1" }));

    const workerStockBeforeConfirm = await apiFetch("/stock-by-site");
    const workerEntry = workerStockBeforeConfirm.sites.find((s) => s.site.id === workerRes.id);
    assert(!workerEntry || workerEntry.lots.length === 0, "CRITICAL: after shipping but before confirming receipt, the worker's site shows NOTHING — matches the two-step design exactly");

    await apiFetch("/dispatches/" + issueRes.dispatch_id + "/receive", postJSON({ confirmations: [{ dispatch_item_id: dItem.id, received_quantity: 10 }] }));
    const workerStockAfterConfirm = await apiFetch("/stock-by-site");
    const workerEntryAfter = workerStockAfterConfirm.sites.find((s) => s.site.id === workerRes.id);
    assert(workerEntryAfter.lots.length === 1 && workerEntryAfter.lots[0].quantity_balance === 10, "after confirming, the worker's stock now correctly shows 10");

    section("=== Material return with wastage (return.js exact field names) ===");
    const openIssues = await apiFetch("/material-issues-by-lot?lot_id=" + lot.id);
    assert(openIssues.open_issues.length === 1, "the open issue is findable by scanning the original lot id");
    const returnRes = await apiFetch("/material-issues/" + openIssues.open_issues[0].id + "/return", postJSON({ quantity_returned_stock: 2, quantity_wasted: 1 }));
    assert(returnRes.ok, "confirmMaterialReturn()'s exact field names accepted");

    section("=== Receive finished good — now the full two-step ship-back flow, closing the WO ===");
    const shipBackRes = await apiFetch("/work-orders/" + wo.id + "/ship-back", postJSON({ output_item_id: finishedItem.id, new_item_name: null, quantity: 2 }));
    assert(shipBackRes.dispatch_id && shipBackRes.mismatch === false, "shipBackFromMyWork()'s exact field names create a return dispatch, correctly matching the intended item");

    const shipBackDetail = await apiFetch("/dispatches/" + shipBackRes.dispatch_id);
    const sbItem = shipBackDetail.items[0];
    await apiFetch("/dispatches/" + shipBackRes.dispatch_id + "/scan", postJSON({ item_id: sbItem.item_id, lot_id: null, scanned_quantity: 2 }));
    await apiFetch("/dispatches/" + shipBackRes.dispatch_id + "/ship", postJSON({ courier: "", tracking_id: "" }));
    const recvRes = await apiFetch("/dispatches/" + shipBackRes.dispatch_id + "/receive", postJSON({ confirmations: [{ dispatch_item_id: sbItem.id, received_quantity: 2 }], labor_cost: 300 }));
    assert(recvRes.ok && recvRes.work_order_closed, "the store's confirm-receipt (with labor_cost, the openReceiveConfirm()/submitReceiveConfirm() shape) closes the work order");

    section("=== Customer Order — simplified, multi-line, then bill + ship ===");
    const co = await apiFetch("/customer-orders", postJSON({ customer_party_id: anu.id, customer_name: "Anu", customer_phone: "", items: [{ item_id: finishedItem.id, quantity: 1, tax_rate: 12 }], promised_delivery_date: null }));
    assert(co.id, "createCO()'s multi-line field set accepted, no cascade fields expected back");
    const coDetail = await apiFetch("/customer-orders/" + co.id);
    assert(coDetail.items[0].current_stock !== undefined, "viewCO()'s expected per-line current_stock field is present");

    const billRes = await apiFetch("/customer-orders/" + co.id + "/bill", postJSON({ line_prices: { [coDetail.items[0].id]: { sale_price: 5000 } } }));
    assert(billRes.ok, "billCO()'s line_prices shape accepted");
    await apiFetch("/customer-orders/" + co.id + "/ship", postJSON({ courier: "BlueDart", tracking_id: "" }));
    const coFinal = await apiFetch("/customer-orders/" + co.id);
    assert(coFinal.status === "shipped", "order correctly moved through billed -> shipped");
    await apiFetch("/customer-orders/" + co.id, patchJSON({ tracking_id: "LATE123" }));

    section("=== Sales with tax (multi-line shape), Expenses with category, Refunds ===");
    const saleRes = await apiFetch("/sales", postJSON({ lines: [{ item_id: null, lot_id: null, quantity: 1, description: "Walk-in", sale_price: 1000, tax_rate: 5 }], customer_party_id: null, customer_name: null }));
    assert(saleRes.lines[0].tax_amount === 50 && saleRes.total_amount === 1050, "createSale()'s multi-line fields compute tax correctly");

    const expCat = await apiFetch("/expense-categories", postJSON({ name: "Test Category" }));
    const expRes = await apiFetch("/expenses", postJSON({ description: "Rent", expense_category_id: expCat.id, amount: 500 }));
    assert(expRes.id, "createExpense()'s exact fields (expense_category_id, not free-text category) accepted");

    const refundRes = await apiFetch("/refunds", postJSON({ sale_id: saleRes.id, amount: 100, reason: "test" }));
    assert(refundRes.id, "createRefund() accepted");

    section("=== Payments Receivable/Payable/Worker — exact allocation shape from submitPayment() ===");
    const outstandingRes = await apiFetch("/outstanding-bills?party_id=" + anu.id + "&direction=receivable");
    assert(Array.isArray(outstandingRes.bills), "loadOutstandingFor()'s expected shape present");

    const supplierParty = await apiFetch("/parties", postJSON({ name: "TestSupplier", type: "supplier" }));
    const workerParty = workerRes.worker_party_id;

    const payRecv = await apiFetch("/payments", postJSON({ party_id: anu.id, direction: "receivable", amount: 100, reference: "", allocations: [] }));
    assert(payRecv.id, "submitPayment('receivable')'s exact body shape accepted");
    const payWorker = await apiFetch("/payments", postJSON({ party_id: workerParty, direction: "worker", amount: 50, allocations: [] }));
    assert(payWorker.id, "submitPayment('worker') works identically");

    section("=== General Journal + Ledger (account+date filter) ===");
    const accounts = await apiFetch("/accounts");
    assert(accounts.length > 10, "populateAccountDropdown()'s expected data present");
    const cashAccount = accounts.find((a) => a.code === "1000");
    const salesAccount = accounts.find((a) => a.code === "3900" || a.name.includes("Opening"));

    const jeRes = await apiFetch("/journal-entries", postJSON({ date: "2026-08-01", description: "test manual entry", debit_account_id: cashAccount.id, credit_account_id: accounts.find((a) => a.code === "2100").id, amount: 25 }));
    assert(jeRes.id, "createJournalEntry()'s exact field names accepted");

    const ledgerRes = await apiFetch("/ledger?account_id=" + cashAccount.id);
    assert(Array.isArray(ledgerRes.entries) && ledgerRes.entries.length > 0, "loadLedgerView()'s expected shape present, with real entries against Cash");

    const pnlRes = await apiFetch("/reports/pnl");
    assert(pnlRes.net_profit !== undefined, "loadPnL()'s expected fields present");

    section("=== Photo upload end to end ===");
    const fd = new FormData();
    fd.append("photo", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "test.jpg");
    const photoRes = await apiFetch("/items/" + finishedItem.id + "/photo", { method: "POST", body: fd });
    assert(photoRes.ok, "real multipart photo upload still works");

    section("=== Item edit (the previously-missing edit form) ===");
    const editRes = await apiFetch("/items/" + finishedItem.id, patchJSON({ name: "Test Saree", color: "Red", price: 5500, cost: null, description: "" }));
    assert(editRes.ok, "saveItemEdit()'s exact field set accepted — this is the fix for the original missing-edit-option problem");

    section("=== BOM save (saveBom()'s exact shape) and preview (refreshBomPreview()'s exact call) ===");
    const rawItem2 = await apiFetch("/items", postJSON({ item_type: "raw_material", name: "Thread", category_id: null, fabric_id: null, work_type_id: null, pattern_id: null, unit_of_measure: "metre", color: "", price: null, cost: null, description: "" }));
    const bomSaveRes = await apiFetch("/items/" + finishedItem.id + "/bom", postJSON({ lines: [{ raw_material_item_id: rawItem.id, quantity_required: 5 }, { raw_material_item_id: rawItem2.id, quantity_required: 2 }] }));
    assert(bomSaveRes.ok, "saveBom()'s exact field shape accepted");

    const bomListRes = await apiFetch("/items/" + finishedItem.id + "/bom");
    assert(bomListRes.length === 2, "loadBomEditor()'s expected GET shape returns both lines");

    const previewRes = await apiFetch("/work-orders/bom-preview?intended_item_id=" + finishedItem.id + "&worker_site_id=" + workerRes.id + "&target_quantity=1");
    assert(previewRes.lines.length === 2, "refreshBomPreview()'s exact query params work, returning both suggested lines");

    section("=== Work order creation with the new mandatory/job_type/material_lines shape ===");
    const woWithBom = await apiFetch("/work-orders", postJSON({
      description: "Job with BOM", work_instructions: "", worker_site_id: workerRes.id, intended_item_id: finishedItem.id, job_type: "production",
      target_quantity: 1, priority: "normal", due_date: null, related_customer_order_id: null,
      material_lines: previewRes.lines.map((l) => ({ raw_material_item_id: l.raw_material_item_id, quantity: l.suggested_quantity })),
    }));
    assert(woWithBom.id && Array.isArray(woWithBom.bom_results), "createWO()'s exact shape (including material_lines override) accepted, bom_results returned for the summary message");

    section("=== Rework: issue, then return, using the exact frontend shapes ===");
    const reworkLot = await apiFetch("/item-lots", postJSON({ item_id: finishedItem.id, site_id: store.id, quantity: 1, source_type: "work_order_output" }));
    const reworkWO = await apiFetch("/work-orders", postJSON({
      description: "Fix it", work_instructions: "", worker_site_id: workerRes.id, intended_item_id: finishedItem.id, job_type: "rework", rework_lot_id: reworkLot.id,
      target_quantity: 1, priority: "normal", due_date: null,
    }));
    assert(reworkWO.id, "createWO()'s rework shape (job_type + rework_lot_id) accepted");

    const reworkIssueRes = await apiFetch("/work-orders/" + reworkWO.id + "/issue-rework", postJSON({}));
    assert(reworkIssueRes.dispatch_id, "issueRework()'s exact call (empty body, WO already knows its own lot) works");

    const reworkDispatchDetail = await apiFetch("/dispatches/" + reworkIssueRes.dispatch_id);
    const reworkDispItem = reworkDispatchDetail.items[0];
    await apiFetch("/dispatches/" + reworkIssueRes.dispatch_id + "/scan", postJSON({ item_id: reworkDispItem.item_id, lot_id: reworkDispItem.lot_id, scanned_quantity: 1 }));
    await apiFetch("/dispatches/" + reworkIssueRes.dispatch_id + "/ship", postJSON({ courier: "", tracking_id: "" }));
    const reworkShippedItem = await apiFetch("/dispatches/" + reworkIssueRes.dispatch_id).then((d) => d.items[0]);
    await apiFetch("/dispatches/" + reworkIssueRes.dispatch_id + "/receive", postJSON({ confirmations: [{ dispatch_item_id: reworkShippedItem.id, received_quantity: 1 }] }));

    const woDetailAfterRework = await apiFetch("/work-orders/" + reworkWO.id);
    assert(woDetailAfterRework.rework_issues.length === 1, "viewWO()'s expected rework_issues field is present after confirm-receive");

    const reworkReturnRes = await apiFetch("/rework-issues/" + woDetailAfterRework.rework_issues[0].id + "/return", postJSON({ quantity_returned: 1, quantity_wasted: 0 }));
    assert(reworkReturnRes.ok && reworkReturnRes.fully_reconciled, "confirmReworkReturn()'s exact shape accepted and closes the cycle");

  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error("TEST HARNESS CRASHED:", e); process.exit(1); });
