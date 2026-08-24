export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const workerSiteId = url.searchParams.get("worker_site_id");
  const search = url.searchParams.get("search");

  const conditions = [];
  const params = [];
  if (workerSiteId) { conditions.push("w.worker_site_id = ?"); params.push(workerSiteId); }
  if (search) {
    conditions.push("(w.id LIKE ? OR w.description LIKE ? OR co.id LIKE ? OR co.customer_name LIKE ? OR co.reseller_name LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like, like, like);
  }
  const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  const { results } = await env.DB.prepare(
    `SELECT w.id, w.description, w.stage, w.job_type, w.target_quantity, w.received_quantity_total, w.due_date, w.cancelled_at, w.closed_at,
            w.created_at, w.related_customer_order_id,
            s.name AS worker_site_name, i.name AS intended_item_name, i.item_code AS intended_item_code,
            co.customer_name, co.reseller_name, co.promised_delivery_date, co.status AS co_status
     FROM work_orders w
     LEFT JOIN sites s ON s.id = w.worker_site_id
     LEFT JOIN items i ON i.id = w.intended_item_id
     LEFT JOIN customer_orders co ON co.id = w.related_customer_order_id
     ${whereClause}
     ORDER BY w.created_at DESC`
  ).bind(...params).all();

  const stageOrder = ["Order Placed", "Material Received", "Work Started", "Work Done", "Work Shipped"];
  const byStage = {};
  for (const stage of stageOrder) byStage[stage] = [];
  const other = [];
  for (const wo of results) {
    const effectiveStage = wo.cancelled_at ? "Cancelled" : wo.stage;
    if (byStage[effectiveStage]) byStage[effectiveStage].push(wo);
    else other.push(wo);
  }
  if (other.length) byStage["Cancelled"] = (byStage["Cancelled"] || []).concat(other);

  return Response.json({ by_stage: byStage, all: results });
}
