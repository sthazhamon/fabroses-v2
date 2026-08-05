const VALID_STAGES = [
  "Order Placed", "Cutting", "Handwork", "Stitching", "Quality Check",
  "Correction Required", "Packed", "Dispatched", "Delivered",
];

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { stage, changed_by } = body;
  if (!VALID_STAGES.includes(stage)) {
    return Response.json({ error: `stage must be one of: ${VALID_STAGES.join(", ")}` }, { status: 400 });
  }
  await env.DB.prepare("UPDATE work_orders SET stage = ?, updated_at = datetime('now') WHERE id = ?").bind(stage, params.id).run();
  await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, ?, ?)").bind(params.id, stage, changed_by || "unknown").run();
  return Response.json({ ok: true, stage });
}
