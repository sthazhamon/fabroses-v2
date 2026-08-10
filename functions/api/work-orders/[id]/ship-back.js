import { createDispatch } from "../../_dispatch.js";

async function nextItemId(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM items").first();
  return "ITM-" + String((row?.c || 0) + 1).padStart(6, "0");
}

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { output_item_id, new_item_name, quantity, to_site_id, force } = body;
  if (!quantity) return Response.json({ error: "quantity is required" }, { status: 400 });

  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Work order not found" }, { status: 404 });
  if (order.closed_at) return Response.json({ error: "This work order is already closed" }, { status: 400 });
  if (order.stage === "Work Shipped") return Response.json({ error: "This job has already been shipped back — nothing left to ship again" }, { status: 400 });

  // The finished item is generally already known from the work order itself
  // (its intended item) — no need to ask the worker to identify it again,
  // unless this WO genuinely has no intended item set.
  let finalItemId = output_item_id || order.intended_item_id || null;
  if (!finalItemId && new_item_name) {
    finalItemId = await nextItemId(env);
    await env.DB.prepare("INSERT INTO items (id, item_type, name, description) VALUES (?, 'finished_good', ?, ?)")
      .bind(finalItemId, new_item_name, `Made from ${params.id}`).run();
  }
  if (!finalItemId) return Response.json({ error: "Provide output_item_id (existing item) or new_item_name" }, { status: 400 });

  // Check against what this work order was actually supposed to produce —
  // same principle as scanning the wrong raw material, just on this leg.
  // A mismatch is a warning, not a hard block, unless force is explicitly false.
  let mismatch = false;
  if (order.intended_item_id && order.intended_item_id !== finalItemId) {
    mismatch = true;
    if (force === false) {
      return Response.json({ error: "Item doesn't match this work order's intended item", mismatch: true }, { status: 409 });
    }
  }

  let storeSiteId = to_site_id;
  if (!storeSiteId) {
    const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();
    if (!storeSite) return Response.json({ error: "No store site exists to ship to" }, { status: 400 });
    storeSiteId = storeSite.id;
  }

  const dispatchId = await createDispatch(env, {
    dispatch_type: "return_shipment", from_site_id: order.worker_site_id, to_site_id: storeSiteId,
    items: [{ item_id: finalItemId, expected_quantity: quantity }], related_work_order_id: params.id,
  });

  return Response.json({ dispatch_id: dispatchId, item_id: finalItemId, mismatch });
}
