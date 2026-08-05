import { createSale } from "../../_sales.js";

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  const { sale_price, lot_id } = body;
  if (!sale_price) return Response.json({ error: "sale_price is required" }, { status: 400 });

  const order = await env.DB.prepare("SELECT * FROM customer_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Customer order not found" }, { status: 404 });
  if (["billed", "shipped", "cancelled"].includes(order.status)) {
    return Response.json({ error: `This order is already ${order.status}` }, { status: 400 });
  }

  let saleRes;
  try {
    saleRes = await createSale(env, {
      item_id: order.item_id, lot_id, quantity: order.quantity, description: order.description,
      customer_party_id: order.customer_party_id, customer_name: order.customer_name,
      sale_price, tax_rate: order.tax_rate, created_by: data.user?.name,
    });
  } catch (e) {
    return Response.json({ error: e.error || e.message }, { status: e.status || 400 });
  }

  await env.DB.prepare("UPDATE customer_orders SET status = 'billed', sale_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(saleRes.id, params.id).run();

  return Response.json({ ok: true, sale_id: saleRes.id });
}
