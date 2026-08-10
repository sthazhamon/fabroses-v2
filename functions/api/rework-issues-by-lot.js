export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lotId = url.searchParams.get("lot_id");
  if (!lotId) return Response.json({ error: "lot_id is required" }, { status: 400 });

  const { results } = await env.DB.prepare(
    `SELECT ri.*, w.description AS work_order_description, s.name AS worker_site_name
     FROM rework_issues ri
     LEFT JOIN work_orders w ON w.id = ri.work_order_id
     LEFT JOIN sites s ON s.id = ri.worker_site_id
     WHERE ri.lot_id = ? AND ri.status IN ('with_worker', 'partially_returned')
     ORDER BY ri.issued_at ASC`
  ).bind(lotId).all();

  return Response.json({ open_issues: results });
}
