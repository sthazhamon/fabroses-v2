// Material Received and Work Shipped are set automatically by the dispatch
// engine (confirming raw material arrival, and shipping the finished good
// back) — not directly settable here. This endpoint only handles the one
// genuinely manual transition: the worker saying they've begun.
const MANUALLY_SETTABLE_STAGES = ["Work Started"];

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { stage, changed_by } = body;
  if (!MANUALLY_SETTABLE_STAGES.includes(stage)) {
    return Response.json({ error: `This stage isn't manually settable. Only "Work Started" is — the others are set automatically when material is confirmed received or the finished good is shipped.` }, { status: 400 });
  }

  const { results: openIssues } = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ? AND status != 'received'").bind(params.id).all();
  const unverified = openIssues.filter((i) => !i.verified_at);
  if (unverified.length) {
    return Response.json({ error: `${unverified.length} raw material line(s) still need to be scan-verified before work can start.` }, { status: 400 });
  }

  await env.DB.prepare("UPDATE work_orders SET stage = ?, updated_at = datetime('now') WHERE id = ?").bind(stage, params.id).run();
  await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, ?, ?)").bind(params.id, stage, changed_by || "unknown").run();
  return Response.json({ ok: true, stage });
}
