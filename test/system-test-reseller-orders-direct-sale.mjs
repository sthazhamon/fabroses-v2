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
  section("=== Setup: a reseller with one CO-based order and one direct sale with no CO at all ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const partiesMod = await import("../functions/api/parties.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const salesMod = await import("../functions/api/sales.js");
  const portalMod = await import("../functions/api/reseller-portal.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });

  const reseller = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy Resellers", type: "reseller" }), env })).json();

  // A CO-based order, fully shipped with tracking info.
  const co = await (await coMod.onRequestPost({ request: req({ customer_party_id: reseller.id, customer_name: "Cozy Resellers", items: [{ item_id: item.id, quantity: 1 }] }), env })).json();
  await env.DB.prepare("UPDATE customer_orders SET status = 'shipped', courier = 'BlueDart', tracking_id = 'BD12345', dispatch_date = '2026-08-20' WHERE id = ?").bind(co.id).run();

  // A direct sale to the SAME reseller, with NO customer order ever created for it - this is the exact reported gap.
  const directSaleRes = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 3000 }], customer_party_id: reseller.id, customer_name: null, sale_date: "2026-08-22" }), env, data: {} })).json();

  section("=== My orders now includes BOTH the CO-based order and the direct sale ===");
  const portalRes = await (await portalMod.onRequestGet({ env, data: { user: { role: "reseller", resellerPartyId: reseller.id } } })).json();
  assert(portalRes.orders.length === 2, `CRITICAL: both orders now appear (got ${portalRes.orders.length})`);

  const coEntry = portalRes.orders.find((o) => o.id === co.id);
  const directEntry = portalRes.orders.find((o) => o.id === directSaleRes.id);
  assert(coEntry && coEntry.order_type === "customer_order", "the CO-based order is correctly tagged as customer_order");
  assert(directEntry && directEntry.order_type === "direct_sale", "CRITICAL: the direct sale is correctly included and tagged as direct_sale - this was previously invisible entirely");

  section("=== Ship date and tracking are correctly present for the CO-based order ===");
  assert(coEntry.courier === "BlueDart" && coEntry.tracking_id === "BD12345" && coEntry.dispatch_date === "2026-08-20", "the CO's own courier/tracking/dispatch date are correctly present");

  section("=== A direct sale correctly shows no shipping info, rather than a crash or fake data ===");
  assert(directEntry.courier === null && directEntry.tracking_id === null, "a direct sale honestly shows no shipping info, since none was ever recorded");
  assert(directEntry.sale_total === 3000, "the direct sale's own total is correctly included");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
