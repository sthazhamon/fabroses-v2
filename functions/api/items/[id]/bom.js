export async function onRequestGet({ env, params }) {
  const { results } = await env.DB.prepare(
    "SELECT b.*, i.name AS raw_material_name, i.unit_of_measure FROM item_bom b LEFT JOIN items i ON i.id = b.raw_material_item_id WHERE b.finished_item_id = ?"
  ).bind(params.id).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { lines } = body; // [{ raw_material_item_id, quantity_required }]
  if (!lines || !lines.length) return Response.json({ error: "At least one BOM line is required" }, { status: 400 });

  const finishedItem = await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(params.id).first();
  if (!finishedItem) return Response.json({ error: "Item not found" }, { status: 404 });

  await env.DB.prepare("DELETE FROM item_bom WHERE finished_item_id = ?").bind(params.id).run();
  for (const line of lines) {
    if (!line.raw_material_item_id || !line.quantity_required) return Response.json({ error: "Each BOM line needs raw_material_item_id and quantity_required" }, { status: 400 });
    const rawItem = await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(line.raw_material_item_id).first();
    if (!rawItem) return Response.json({ error: `Raw material ${line.raw_material_item_id} not found` }, { status: 404 });
    await env.DB.prepare("INSERT INTO item_bom (finished_item_id, raw_material_item_id, quantity_required) VALUES (?, ?, ?)")
      .bind(params.id, line.raw_material_item_id, line.quantity_required).run();
  }

  return Response.json({ ok: true });
}
