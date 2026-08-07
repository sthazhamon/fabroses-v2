async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestGet({ env }) {
  const { results: orders } = await env.DB.prepare("SELECT * FROM customer_orders ORDER BY created_at DESC").all();
  const withLines = [];
  for (const order of orders) {
    const { results: items } = await env.DB.prepare(
      "SELECT coi.*, i.name AS item_name FROM customer_order_items coi LEFT JOIN items i ON i.id = coi.item_id WHERE coi.customer_order_id = ?"
    ).bind(order.id).all();
    withLines.push({ ...order, items });
  }
  return Response.json(withLines);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { customer_party_id, customer_name, customer_phone, order_date, promised_delivery_date, notes, items } = body;

  if (!customer_name) return Response.json({ error: "customer_name is required" }, { status: 400 });
  if (!items || !items.length) return Response.json({ error: "At least one line item is required" }, { status: 400 });

  for (const item of items) {
    if (!item.item_id && !item.description) return Response.json({ error: "Each line needs either an item or a description" }, { status: 400 });
  }

  const id = await nextId(env, "customer_orders", "CO");
  await env.DB.prepare(
    `INSERT INTO customer_orders (id, customer_party_id, customer_name, customer_phone, order_date, promised_delivery_date, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'received', ?)`
  ).bind(id, customer_party_id || null, customer_name, customer_phone || null, order_date || new Date().toISOString().slice(0, 10), promised_delivery_date || null, notes || null).run();

  for (const item of items) {
    let effectiveDescription = item.description || null;
    if (item.item_id && !effectiveDescription) {
      const found = await env.DB.prepare("SELECT name FROM items WHERE id = ?").bind(item.item_id).first();
      if (!found) return Response.json({ error: `Item ${item.item_id} not found` }, { status: 404 });
      effectiveDescription = found.name;
    }
    await env.DB.prepare("INSERT INTO customer_order_items (customer_order_id, item_id, description, quantity, tax_rate) VALUES (?, ?, ?, ?, ?)")
      .bind(id, item.item_id || null, effectiveDescription, item.quantity || 1, item.tax_rate || 0).run();
  }

  return Response.json({ id });
}
