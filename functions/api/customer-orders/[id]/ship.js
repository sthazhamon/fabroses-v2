export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { courier, tracking_id, dispatch_date } = body;
  const order = await env.DB.prepare("SELECT * FROM customer_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Customer order not found" }, { status: 404 });
  if (order.status !== "billed") return Response.json({ error: "Bill this order before shipping it" }, { status: 400 });

  await env.DB.prepare(
    "UPDATE customer_orders SET status = 'shipped', courier = ?, tracking_id = ?, dispatch_date = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(courier || null, tracking_id || null, dispatch_date || new Date().toISOString().slice(0, 10), params.id).run();

  return Response.json({ ok: true });
}
