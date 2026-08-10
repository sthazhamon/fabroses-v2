export async function onRequestPost({ env, params, data }) {
  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Work order not found" }, { status: 404 });
  if (order.closed_at) return Response.json({ error: "Already closed — nothing to cancel" }, { status: 400 });
  if (order.cancelled_at) return Response.json({ error: "Already cancelled" }, { status: 400 });
  if (order.stage === "Work Shipped") {
    return Response.json({ error: "This job has already been shipped back — it's too far along to cancel. Let the store confirm receipt first." }, { status: 400 });
  }

  await env.DB.prepare("UPDATE work_orders SET cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(params.id).run();
  await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, 'Cancelled', ?)").bind(params.id, data.user?.name || "unknown").run();

  // Free up the customer order line this was for, if any, so it re-enters
  // the backlog and a fresh work order can be created for someone else.
  // Any raw material already issued stays exactly as it is — cancelling
  // the work order doesn't touch material_issues at all; that's resolved
  // independently through the normal material-return process.
  const line = await env.DB.prepare("SELECT * FROM customer_order_items WHERE linked_work_order_id = ?").bind(params.id).first();
  if (line) {
    await env.DB.prepare("UPDATE customer_order_items SET linked_work_order_id = NULL WHERE id = ?").bind(line.id).run();

    const { results: siblingLines } = await env.DB.prepare(
      "SELECT coi.*, w.closed_at AS wo_closed_at FROM customer_order_items coi LEFT JOIN work_orders w ON w.id = coi.linked_work_order_id WHERE coi.customer_order_id = ?"
    ).bind(line.customer_order_id).all();
    const anyLinked = siblingLines.some((l) => l.linked_work_order_id);
    const currentOrder = await env.DB.prepare("SELECT status FROM customer_orders WHERE id = ?").bind(line.customer_order_id).first();
    if (currentOrder && !["billed", "shipped", "cancelled"].includes(currentOrder.status)) {
      const newStatus = anyLinked ? "partially_fulfilled" : "received";
      await env.DB.prepare("UPDATE customer_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(newStatus, line.customer_order_id).run();
    }
  }

  const outstandingIssues = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM material_issues WHERE work_order_id = ? AND status != 'received'"
  ).bind(params.id).first();

  return Response.json({ ok: true, outstanding_material_issues: outstandingIssues.c });
}
