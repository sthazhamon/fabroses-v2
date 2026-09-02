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
  section("=== Setup: a mix of work orders, unsold stock, and items with/without a BOM ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const alertsMod = await import("../functions/api/dashboard-alerts.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const withBom = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree With BOM" }), env })).json();
  const raw = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Fabric" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: raw.id, quantity_required: 5 }] }), env, params: { id: withBom.id } });
  const noBom = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree No BOM" }), env })).json();

  await lotsMod.onRequestPost({ request: req({ item_id: withBom.id, site_id: store.id, quantity: 4, source_type: "opening_stock" }), env, data: {} });
  await woMod.onRequestPost({ request: req({ description: "Open job", worker_site_id: worker.id, intended_item_id: withBom.id, target_quantity: 1 }), env, data: {} });

  section("=== CRITICAL: all three new dashboard sections correctly surface real data ===");
  const alerts = await (await alertsMod.onRequestGet({ env })).json();

  assert(alerts.pending_work_orders.length === 1, `CRITICAL: the open work order correctly appears under pending_work_orders, got ${alerts.pending_work_orders.length}`);

  const unsoldEntry = alerts.unsold_stock.find((s) => s.item_id === withBom.id);
  assert(unsoldEntry && unsoldEntry.total_stock === 4, `CRITICAL: unsold finished-goods stock is correctly surfaced, got ${unsoldEntry?.total_stock}`);

  const missingBomIds = alerts.items_missing_bom.map((i) => i.item_id);
  assert(missingBomIds.includes(noBom.id), "CRITICAL: the finished item with no BOM at all is correctly surfaced");
  assert(!missingBomIds.includes(withBom.id), "the item that already HAS a BOM is correctly excluded, not falsely flagged");
  assert(!missingBomIds.includes(raw.id), "a raw material (not a finished good) is correctly never flagged for a missing BOM at all");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
