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
  section("=== Setup: two store sites with stock ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const transferMod = await import("../functions/api/transfer-stock.js");

  const storeA = await (await sitesMod.onRequestPost({ request: req({ name: "FB Store", site_type: "store" }), env })).json();
  const storeB = await (await sitesMod.onRequestPost({ request: req({ name: "Branch Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: storeA.id, quantity: 20, source_type: "direct_intake" }), env, data: {} })).json();

  section("=== A valid transfer between two stores creates a real dispatch ===");
  const transferRes = await (await transferMod.onRequestPost({ request: req({ from_site_id: storeA.id, to_site_id: storeB.id, lot_id: lot.id, quantity: 5 }), env })).json();
  assert(transferRes.dispatch_id, "the transfer correctly creates a dispatch");

  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(transferRes.dispatch_id).first();
  assert(dispatch.status === "pending_pick", "CRITICAL: the transfer correctly requires the normal pick/ship/confirm flow, not an instant move");
  assert(dispatch.from_site_id === storeA.id && dispatch.to_site_id === storeB.id, "the dispatch correctly records both sites");

  const lotAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE id = ?").bind(lot.id).first();
  assert(lotAfter.quantity_balance === 20, "the source lot is correctly untouched until the dispatch is actually shipped");

  section("=== Transferring more than what's available is correctly refused ===");
  const overRes = await (await transferMod.onRequestPost({ request: req({ from_site_id: storeA.id, to_site_id: storeB.id, lot_id: lot.id, quantity: 999 }), env })).json();
  assert(overRes.error, "requesting more than what's in the lot is correctly rejected");

  section("=== Transferring from a site that doesn't actually hold the lot is correctly refused ===");
  const wrongSiteRes = await (await transferMod.onRequestPost({ request: req({ from_site_id: storeB.id, to_site_id: storeA.id, lot_id: lot.id, quantity: 1 }), env })).json();
  assert(wrongSiteRes.error, "attempting to transfer FROM a site that doesn't actually hold this lot is correctly rejected");

  section("=== Same from/to site is correctly refused ===");
  const sameRes = await (await transferMod.onRequestPost({ request: req({ from_site_id: storeA.id, to_site_id: storeA.id, lot_id: lot.id, quantity: 1 }), env })).json();
  assert(sameRes.error, "transferring a site to itself is correctly rejected");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
