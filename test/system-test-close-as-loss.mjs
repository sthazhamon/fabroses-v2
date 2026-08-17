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
  section("=== Setup: a shipped dispatch that never gets confirmed ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch } = await import("../functions/api/_dispatch.js");
  const closeAsLossMod = await import("../functions/api/dispatches/[id]/close-as-loss.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake", cost_total: 500 }), env, data: {} })).json();

  section("=== Closing as loss is correctly refused before it's actually shipped ===");
  const dispatchIdEarly = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 5 }] });
  const blockedTooEarly = await (await closeAsLossMod.onRequestPost({ env, params: { id: dispatchIdEarly }, data: {} })).json();
  assert(blockedTooEarly.error, "closing as loss is correctly refused while still pending_pick — nothing's actually gone anywhere yet");

  await confirmPick(env, dispatchIdEarly, { item_id: item.id, lot_id: lot.id, scanned_quantity: 5 });
  await shipDispatch(env, dispatchIdEarly, {}, "store staff");

  section("=== Closing as a loss once genuinely shipped and never confirmed ===");
  const lossRes = await (await closeAsLossMod.onRequestPost({ env, params: { id: dispatchIdEarly }, data: { user: { name: "Admin" } } })).json();
  assert(lossRes.ok, "closing as loss succeeds");
  assert(lossRes.total_loss_value === 250, `CRITICAL: loss value correctly computed from the lot's own cost (500/10=50 per unit x 5 shipped = 250), got ${lossRes.total_loss_value}`);

  const dispatchAfter = await env.DB.prepare("SELECT status FROM dispatches WHERE id = ?").bind(dispatchIdEarly).first();
  assert(dispatchAfter.status === "lost", "the dispatch is correctly marked as lost, not silently removed");

  section("=== The loss posts a real journal entry, not just an inventory note ===");
  const lossAccount = await env.DB.prepare("SELECT id FROM accounts WHERE code = '4200'").first();
  const inventoryAccount = await env.DB.prepare("SELECT id FROM accounts WHERE code = '1200'").first();
  const lossDebit = await env.DB.prepare("SELECT COALESCE(SUM(debit),0) AS t FROM journal_lines WHERE account_id = ?").bind(lossAccount.id).first();
  const inventoryCredit = await env.DB.prepare("SELECT COALESCE(SUM(credit),0) AS t FROM journal_lines WHERE account_id = ?").bind(inventoryAccount.id).first();
  assert(lossDebit.t === 250, `CRITICAL: the Inventory Loss account is correctly debited 250, got ${lossDebit.t}`);
  assert(inventoryCredit.t === 250, `the inventory asset account is correctly credited the same 250, keeping the entry balanced`);

  section("=== The loss shows up visibly in the movement register ===");
  const movementRow = await env.DB.prepare("SELECT * FROM item_movements WHERE dispatch_id = ? AND event_type = 'lost_in_transit'").bind(dispatchIdEarly).first();
  assert(movementRow && movementRow.quantity === 5, "a real, visible movement record shows the write-off, not a silent disappearance");

  section("=== Can't close the same dispatch as a loss twice ===");
  const doubleAttempt = await (await closeAsLossMod.onRequestPost({ env, params: { id: dispatchIdEarly }, data: {} })).json();
  assert(doubleAttempt.error, "attempting to close an already-lost dispatch a second time is correctly rejected");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
