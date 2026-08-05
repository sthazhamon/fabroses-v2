export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT po.*, i.name AS item_name FROM purchase_orders po LEFT JOIN items i ON i.id = po.item_id ORDER BY po.created_at DESC`
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { supplier_party_id, supplier_name, item_id, quantity_ordered, rate, expected_date, notes } = body;
  if (!supplier_name || !item_id || !quantity_ordered) {
    return Response.json({ error: "supplier_name, item_id, and quantity_ordered are required" }, { status: 400 });
  }
  const item = await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(item_id).first();
  if (!item) return Response.json({ error: "Item not found" }, { status: 404 });

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM purchase_orders").first();
  const id = "PO-" + String((countRow?.c || 0) + 1).padStart(6, "0");

  await env.DB.prepare(
    "INSERT INTO purchase_orders (id, supplier_party_id, supplier_name, item_id, quantity_ordered, rate, expected_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, supplier_party_id || null, supplier_name, item_id, quantity_ordered, rate || null, expected_date || null, notes || null).run();

  return Response.json({ id });
}
