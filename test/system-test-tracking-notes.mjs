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
  section("=== Setup: a shipped dispatch with courier/tracking set at ship time ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();

  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 10 }] });
  await confirmPick(env, dispatchId, { item_id: item.id, lot_id: lot.id, scanned_quantity: 10 });
  await shipDispatch(env, dispatchId, { courier: "DTDC", tracking_id: "T-ORIGINAL-001" }, "store staff");

  const trackingMod = await import("../functions/api/dispatches/[id]/tracking.js");

  section("=== The original entry is now locked — never overwritten ===");
  const firstAdd = await (await trackingMod.onRequestPost({ request: req({ courier: "BlueDart", tracking_id: "T-WRONG-999" }), env, params: { id: dispatchId }, data: { user: { name: "Admin" } } })).json();
  assert(firstAdd.ok && firstAdd.locked_original === false, "a SECOND courier/tracking submission does NOT report itself as the locked original — it went in as a note instead");

  const dispatchAfter = await env.DB.prepare("SELECT courier, tracking_id FROM dispatches WHERE id = ?").bind(dispatchId).first();
  assert(dispatchAfter.courier === "DTDC" && dispatchAfter.tracking_id === "T-ORIGINAL-001", "the ORIGINAL courier/tracking on the dispatch itself is completely untouched — still DTDC / T-ORIGINAL-001");

  section("=== The correction is visible as a note, not lost ===");
  const info = await (await trackingMod.onRequestGet({ env, params: { id: dispatchId } })).json();
  assert(info.original.courier === "DTDC", "GET correctly returns the locked original");
  assert(info.notes.length === 1 && info.notes[0].courier === "BlueDart" && info.notes[0].tracking_id === "T-WRONG-999",
    `the correction shows up as a genuine note, fully preserved (got ${JSON.stringify(info.notes[0])})`);

  section("=== Multiple corrections all stack as notes, none overwriting each other ===");
  await trackingMod.onRequestPost({ request: req({ note: "Courier confirmed pickup delayed a day" }), env, params: { id: dispatchId }, data: { user: { name: "Store staff" } } });
  const infoAfter = await (await trackingMod.onRequestGet({ env, params: { id: dispatchId } })).json();
  assert(infoAfter.notes.length === 2, `both corrections/notes are preserved in order, nothing lost (got ${infoAfter.notes.length})`);

  section("=== The old raw PATCH-overwrite path is genuinely gone ===");
  const dispatchDetailMod = await import("../functions/api/dispatches/[id].js");
  const patchAttempt = await (await dispatchDetailMod.onRequestPatch({ request: req({ courier: "Should not work" }), env, params: { id: dispatchId } })).json();
  assert(patchAttempt.error, "attempting to PATCH courier directly is rejected — tracking.js is now the only path");

  section("=== A dispatch that's never had tracking set yet still locks correctly on its first entry ===");
  const dispatchId2 = await createDispatch(env, { dispatch_type: "return_shipment", from_site_id: worker.id, to_site_id: store.id, items: [{ item_id: item.id, expected_quantity: 1 }] });
  const freshAdd = await (await trackingMod.onRequestPost({ request: req({ courier: "Speed Post", tracking_id: "SP-001" }), env, params: { id: dispatchId2 }, data: {} })).json();
  assert(freshAdd.locked_original === true, "the FIRST tracking entry on a dispatch that never had one correctly becomes the locked original, not a note");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
