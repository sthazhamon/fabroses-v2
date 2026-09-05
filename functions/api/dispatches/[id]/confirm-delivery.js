// Customer shipments end their dispatch-status lifecycle at "shipped" —
// there's no internal party to confirm receipt the way store-to-store
// transfers do. But "shipped" isn't the same thing as "the customer
// actually has it in hand". This is a separate, explicit confirmation
// step layered on top, so the order isn't treated as fully closed out
// until someone actually checks.
export async function onRequestPost({ env, params, data }) {
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(params.id).first();
  if (!dispatch) return Response.json({ error: "Dispatch not found" }, { status: 404 });
  if (dispatch.dispatch_type !== "customer_shipment") {
    return Response.json({ error: "Delivery confirmation only applies to customer shipments — internal transfers are confirmed via the Receive tab instead." }, { status: 400 });
  }
  if (dispatch.status !== "shipped") {
    return Response.json({ error: `Can't confirm delivery — this dispatch is at "${dispatch.status}", not "shipped".` }, { status: 400 });
  }
  if (dispatch.delivery_confirmed_at) {
    return Response.json({ error: "Already confirmed delivered", already_done: true }, { status: 400 });
  }

  await env.DB.prepare("UPDATE dispatches SET delivery_confirmed_at = datetime('now'), delivery_confirmed_by = ? WHERE id = ?")
    .bind(data?.user?.name || "unknown", params.id).run();

  if (dispatch.related_customer_order_id) {
    await env.DB.prepare("UPDATE customer_orders SET status = 'delivered', updated_at = datetime('now') WHERE id = ? AND status NOT IN ('cancelled')")
      .bind(dispatch.related_customer_order_id).run();
  }

  return Response.json({ ok: true });
}
