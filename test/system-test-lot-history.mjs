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
  section("=== Setup: a raw material lot that travels store -> worker -> back ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const woMod = await import("../functions/api/work-orders.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const returnMod = await import("../functions/api/material-issues/[id]/return.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 20, source_type: "direct_intake" }), env, data: {} })).json();
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env })).json();

  const issueRes = await (await issueMod.onRequestPost({ request: req({ lot_id: lot.id, quantity: 10 }), env, params: { id: wo.id } })).json();
  await confirmPick(env, issueRes.dispatch_id, { item_id: item.id, lot_id: lot.id, scanned_quantity: 10 });
  await shipDispatch(env, issueRes.dispatch_id, { courier: "DTDC" }, "store staff");
  const dispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(issueRes.dispatch_id).first();
  await confirmReceive(env, issueRes.dispatch_id, [{ dispatch_item_id: dispItem.id, received_quantity: 10 }], "Zakir");

  const openIssue = await env.DB.prepare("SELECT * FROM material_issues WHERE lot_id = ?").bind(lot.id).first();
  await returnMod.onRequestPost({ request: req({ quantity_returned_stock: 3, quantity_wasted: 1 }), env, params: { id: openIssue.id }, data: { user: {} } });

  section("=== The history endpoint shows the full chronological story ===");
  const historyMod = await import("../functions/api/item-lots/[id]/history.js");
  const history = await (await historyMod.onRequestGet({ env, params: { id: lot.id } })).json();

  assert(history.lot.id === lot.id && history.lot.item_name === "Kota", "the lot itself is correctly identified");
  assert(history.movements.length >= 2, `at least the transfer-out and (from the original lot's perspective) tracking exists (got ${history.movements.length} movements)`);

  const transferOut = history.movements.find((m) => m.event_type === "transferred_out");
  assert(transferOut && transferOut.to_site_name === "Zakir" && transferOut.created_by === "store staff",
    "the transfer-out movement correctly shows who did it and where it went");

  section("=== A brand-new lot shows its own creation as history, not an empty list ===");
  const freshLot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  const freshHistory = await (await historyMod.onRequestGet({ env, params: { id: freshLot.id } })).json();
  assert(freshHistory.movements.length === 1 && freshHistory.movements[0].event_type === "received",
    `a fresh lot correctly shows its own creation as the first history entry, not an empty list (got ${freshHistory.movements.length} movement(s))`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
