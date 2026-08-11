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
  section("=== Setup: a PO with a partially-received line (20 of 50) ===");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const shortCloseMod = await import("../functions/api/purchase-order-items/[id]/short-close.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const sitesMod = await import("../functions/api/sites.js");

  await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env });
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Linen" }), env })).json();
  const po = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cozy", items: [{ item_id: item.id, quantity_ordered: 50, rate: 100 }] }), env })).json();
  const line = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id).items[0];
  await receiveMod.onRequestPost({ request: req({ quantity_received: 20 }), env, params: { id: line.id } });

  const poBeforeClose = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id);
  assert(poBeforeClose.status === "partially_received", "PO correctly sits at partially_received, matching the 20 of 50 report");

  section("=== Short-closing marks it done without needing the remaining 30 ===");
  const closeRes = await (await shortCloseMod.onRequestPost({ env, params: { id: line.id } })).json();
  assert(closeRes.ok, "short-close succeeds on a genuinely incomplete line");

  const poAfterClose = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id);
  assert(poAfterClose.status === "received", `CRITICAL: the PO's overall status correctly resolves to received now that its one line is short-closed, got ${poAfterClose.status}`);
  assert(poAfterClose.items[0].quantity_ordered === 50 && poAfterClose.items[0].quantity_received === 20, "the original ordered and actually-received quantities both stay on record, untouched");

  section("=== A fully received line can't be short-closed — nothing to close ===");
  const item2 = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk" }), env })).json();
  const po2 = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cozy", items: [{ item_id: item2.id, quantity_ordered: 10, rate: 50 }] }), env })).json();
  const line2 = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po2.id).items[0];
  await receiveMod.onRequestPost({ request: req({ quantity_received: 10 }), env, params: { id: line2.id } });

  const blockedAttempt = await (await shortCloseMod.onRequestPost({ env, params: { id: line2.id } })).json();
  assert(blockedAttempt.error, "attempting to short-close an already-fully-received line is correctly rejected");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
