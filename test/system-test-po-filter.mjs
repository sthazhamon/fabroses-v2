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
function getReq(qs) { return { url: "https://x/api/purchase-orders" + qs }; }

async function run() {
  section("=== Setup: two suppliers, a fully closed PO and an open one ===");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const sbMod = await import("../functions/api/supplier-bills.js");
  const partiesMod = await import("../functions/api/parties.js");

  const supplierA = await (await partiesMod.onRequestPost({ request: req({ name: "Cotton Threads", type: "supplier" }), env })).json();
  const supplierB = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy", type: "supplier" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Linen" }), env })).json();
  const sitesMod = await import("../functions/api/sites.js");
  await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env });

  const closedPO = await (await poMod.onRequestPost({ request: req({ supplier_party_id: supplierA.id, supplier_name: "Cotton Threads", items: [{ item_id: item.id, quantity_ordered: 10, rate: 100 }] }), env })).json();
  const closedLine = (await (await poMod.onRequestGet({ request: getReq("?include_closed=true"), env })).json()).find((p) => p.id === closedPO.id).items[0];
  await receiveMod.onRequestPost({ request: req({ quantity_received: 10 }), env, params: { id: closedLine.id } });
  await sbMod.onRequestPost({ request: req({ purchase_order_id: closedPO.id, supplier_name: "Cotton Threads", lines: [{ purchase_order_item_id: closedLine.id, item_id: item.id, quantity: 10, rate: 100 }] }), env, data: {} });

  const openPO = await (await poMod.onRequestPost({ request: req({ supplier_party_id: supplierB.id, supplier_name: "Cozy", items: [{ item_id: item.id, quantity_ordered: 5, rate: 50 }] }), env })).json();

  section("=== By default, only the open PO shows ===");
  const defaultRes = await (await poMod.onRequestGet({ request: getReq(""), env })).json();
  assert(defaultRes.some((p) => p.id === openPO.id), "the open PO correctly shows by default");
  assert(!defaultRes.some((p) => p.id === closedPO.id), "CRITICAL: the fully received-and-billed PO correctly does NOT show by default");

  section("=== include_closed=true correctly shows everything ===");
  const allRes = await (await poMod.onRequestGet({ request: getReq("?include_closed=true"), env })).json();
  assert(allRes.some((p) => p.id === openPO.id) && allRes.some((p) => p.id === closedPO.id), "both POs correctly show when explicitly including closed ones");

  section("=== Filtering by supplier correctly narrows results ===");
  const supplierFilterRes = await (await poMod.onRequestGet({ request: getReq("?supplier_party_id=" + supplierB.id), env })).json();
  assert(supplierFilterRes.length === 1 && supplierFilterRes[0].id === openPO.id, "filtering by supplier B correctly returns only their PO");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
