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
  section("=== Setup: a direct sale from worker stock, producing a real shipment ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const partiesMod = await import("../functions/api/parties.js");
  const salesMod = await import("../functions/api/sales.js");
  const dispatchesMod = await import("../functions/api/dispatches.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 3, source_type: "work_order_output" }), env, data: {} });
  const customer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer" }), env })).json();

  const saleRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Peacock Applique", sale_price: 5000 }], customer_party_id: customer.id, customer_name: null }), env, data: {},
  })).json();

  section("=== CRITICAL: the dispatch list now identifies the shipment by more than just its DSP number ===");
  const list = await (await dispatchesMod.onRequestGet({ env })).json();
  const entry = list.find((d) => d.id === saleRes.shipment_dispatch_id);
  assert(entry.shipping_name === "Susan", `CRITICAL: the list correctly resolves the customer's name for a direct-sale shipment, got "${entry.shipping_name}"`);
  assert(entry.item_summary.includes("Peacock Applique"), "the item name is already correctly shown alongside it");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
