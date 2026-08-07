import { createSale } from "../../_sales.js";

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  const { line_prices } = body; // { [customer_order_item_id]: { sale_price, lot_id } }
  if (!line_prices) return Response.json({ error: "line_prices is required — a sale_price for each line item" }, { status: 400 });

  const order = await env.DB.prepare("SELECT * FROM customer_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Customer order not found" }, { status: 404 });
  if (["billed", "shipped", "cancelled"].includes(order.status)) {
    return Response.json({ error: `This order is already ${order.status}` }, { status: 400 });
  }

  const { results: orderLines } = await env.DB.prepare("SELECT * FROM customer_order_items WHERE customer_order_id = ?").bind(params.id).all();

  let lines;
  try {
    lines = orderLines.map((ol) => {
      const priceInfo = line_prices[ol.id];
      if (!priceInfo || priceInfo.sale_price == null) throw new Error(`Missing sale_price for line ${ol.id}`);
      return { item_id: ol.item_id, lot_id: priceInfo.lot_id || null, quantity: ol.quantity, description: ol.description, sale_price: priceInfo.sale_price, tax_rate: ol.tax_rate };
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400 });
  }

  let saleRes;
  try {
    saleRes = await createSale(env, { lines, customer_party_id: order.customer_party_id, customer_name: order.customer_name, created_by: data.user?.name });
  } catch (e) {
    return Response.json({ error: e.error || e.message }, { status: e.status || 400 });
  }

  await env.DB.prepare("UPDATE customer_orders SET status = 'billed', sale_id = ?, updated_at = datetime('now') WHERE id = ?").bind(saleRes.id, params.id).run();
  return Response.json({ ok: true, sale_id: saleRes.id, total_amount: saleRes.total_amount });
}
