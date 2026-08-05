import { createDispatch } from "./_dispatch.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT d.*, fs.name AS from_site_name, ts.name AS to_site_name
     FROM dispatches d LEFT JOIN sites fs ON fs.id = d.from_site_id LEFT JOIN sites ts ON ts.id = d.to_site_id
     ORDER BY d.created_at DESC`
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { dispatch_type, from_site_id, to_site_id, items, related_work_order_id, related_customer_order_id, related_purchase_order_id } = body;

  const validTypes = ["customer_shipment", "stock_transfer", "return_shipment"];
  if (!validTypes.includes(dispatch_type) || !items || !items.length) {
    return Response.json({ error: `dispatch_type (${validTypes.join(", ")}) and at least one item are required` }, { status: 400 });
  }

  const id = await createDispatch(env, { dispatch_type, from_site_id, to_site_id, items, related_work_order_id, related_customer_order_id, related_purchase_order_id });
  return Response.json({ id });
}
