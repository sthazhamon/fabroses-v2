async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

function deriveStatus(items) {
  const isLineComplete = (i) => i.quantity_received >= i.quantity_ordered || i.status === "short_closed";
  if (items.every(isLineComplete)) return "received";
  if (items.some((i) => i.quantity_received > 0)) return "partially_received";
  return "ordered";
}

export async function onRequestGet({ env }) {
  const { results: orders } = await env.DB.prepare("SELECT * FROM purchase_orders ORDER BY created_at DESC").all();
  const withItems = [];
  for (const po of orders) {
    const { results: items } = await env.DB.prepare(
      `SELECT poi.*, i.name AS item_name FROM purchase_order_items poi LEFT JOIN items i ON i.id = poi.item_id WHERE poi.purchase_order_id = ?`
    ).bind(po.id).all();
    for (const line of items) {
      const billedRow = await env.DB.prepare("SELECT COALESCE(SUM(quantity),0) AS t FROM supplier_bill_items WHERE purchase_order_item_id = ?").bind(line.id).first();
      line.quantity_billed = billedRow.t;
    }
    withItems.push({ ...po, items, status: deriveStatus(items) });
  }
  return Response.json(withItems);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { supplier_party_id, supplier_name, expected_date, notes, items } = body;
  if (!supplier_name || !items || !items.length) {
    return Response.json({ error: "supplier_name and at least one line item are required" }, { status: 400 });
  }
  for (const item of items) {
    if (!item.item_id || !item.quantity_ordered) return Response.json({ error: "Each line needs item_id and quantity_ordered" }, { status: 400 });
    const exists = await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(item.item_id).first();
    if (!exists) return Response.json({ error: `Item ${item.item_id} not found` }, { status: 404 });
  }

  const id = await nextId(env, "purchase_orders", "PO");
  await env.DB.prepare("INSERT INTO purchase_orders (id, supplier_party_id, supplier_name, expected_date, notes) VALUES (?, ?, ?, ?, ?)")
    .bind(id, supplier_party_id || null, supplier_name, expected_date || null, notes || null).run();

  for (const item of items) {
    await env.DB.prepare("INSERT INTO purchase_order_items (purchase_order_id, item_id, quantity_ordered, rate) VALUES (?, ?, ?, ?)")
      .bind(id, item.item_id, item.quantity_ordered, item.rate || null).run();
  }

  return Response.json({ id });
}
