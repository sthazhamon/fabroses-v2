import { nextId } from "./_ledger.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT co.*, i.name AS item_name, i.item_code FROM customer_orders co LEFT JOIN items i ON i.id = co.item_id ORDER BY co.created_at DESC`
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { customer_party_id, customer_name, customer_phone, item_id, description, quantity, order_date, promised_delivery_date, tax_rate, notes } = body;

  if (!customer_name) return Response.json({ error: "customer_name is required" }, { status: 400 });
  if (!item_id && !description) return Response.json({ error: "Provide either an item or a description for a custom order" }, { status: 400 });

  let effectiveDescription = description || null;
  if (item_id && !effectiveDescription) {
    const item = await env.DB.prepare("SELECT name FROM items WHERE id = ?").bind(item_id).first();
    if (!item) return Response.json({ error: "Item not found" }, { status: 404 });
    effectiveDescription = item.name;
  }

  const id = await nextId(env, "customer_orders", "CO");
  await env.DB.prepare(
    `INSERT INTO customer_orders
     (id, customer_party_id, customer_name, customer_phone, item_id, description, quantity, order_date, promised_delivery_date, tax_rate, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
  ).bind(
    id, customer_party_id || null, customer_name, customer_phone || null, item_id || null, effectiveDescription,
    quantity || 1, order_date || new Date().toISOString().slice(0, 10), promised_delivery_date || null, tax_rate || 0, notes || null
  ).run();

  return Response.json({ id });
}
