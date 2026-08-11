import { createDispatch } from "../../_dispatch.js";
import { genuinelyAvailable, genuinelyAvailableAtSite } from "../../_bom.js";

async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { lot_id, quantity } = body;
  if (!lot_id || !quantity) return Response.json({ error: "lot_id and quantity are required" }, { status: 400 });

  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Work order not found" }, { status: 404 });

  const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot_id).first();
  if (!lot) return Response.json({ error: "Lot not found" }, { status: 404 });

  // Already sitting at the worker's own site — nothing to physically move,
  // so skip the dispatch entirely and reserve it directly via a material
  // issue. Consumption itself now happens later, at Mark Job Done, so this
  // doesn't touch the balance yet — but it does need to check against
  // other OPEN reservations on this item at this site, not just pending
  // dispatches, since two reservations could otherwise both claim the same
  // physical stock before either is actually consumed.
  if (lot.site_id === order.worker_site_id) {
    const { available } = await genuinelyAvailableAtSite(env, lot.item_id, order.worker_site_id);
    if (available < quantity) return Response.json({ error: `Only ${available} genuinely available at the worker's site — the rest is already reserved by another job` }, { status: 400 });

    const issueId = await nextId(env, "material_issues", "ISS");
    await env.DB.prepare("INSERT INTO material_issues (id, work_order_id, lot_id, quantity_issued, worker_site_id, status) VALUES (?, ?, ?, ?, ?, 'with_worker')")
      .bind(issueId, params.id, lot_id, quantity, order.worker_site_id).run();
    return Response.json({ issue_id: issueId, direct_issue: true });
  }

  const check = await genuinelyAvailable(env, lot_id);
  if (!check) return Response.json({ error: "Lot not found" }, { status: 404 });
  const { available } = check;
  if (available < quantity) return Response.json({ error: `Only ${available} genuinely available — the rest is already committed to another pending dispatch` }, { status: 400 });

  const dispatchId = await createDispatch(env, {
    dispatch_type: "stock_transfer", from_site_id: lot.site_id, to_site_id: order.worker_site_id,
    items: [{ item_id: lot.item_id, lot_id, expected_quantity: quantity }], related_work_order_id: params.id,
  });

  return Response.json({ dispatch_id: dispatchId, direct_issue: false });
}
