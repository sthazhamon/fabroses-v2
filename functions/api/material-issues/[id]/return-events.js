export async function onRequestGet({ env, params }) {
  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(params.id).first();
  if (!issue) return Response.json({ error: "Material issue not found" }, { status: 404 });

  const { results: events } = await env.DB.prepare(
    `SELECT mre.*, l.item_id AS created_lot_item_id, l.quantity_balance AS created_lot_current_balance, l.quantity_original AS created_lot_original_quantity
     FROM material_return_events mre LEFT JOIN item_lots l ON l.id = mre.created_lot_id
     WHERE mre.material_issue_id = ? ORDER BY mre.created_at ASC, mre.id ASC`
  ).bind(params.id).all();

  return Response.json(events);
}
