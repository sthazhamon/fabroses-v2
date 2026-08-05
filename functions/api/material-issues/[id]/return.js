async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  const { quantity_returned_stock, quantity_wasted, destination_site_id, notes } = body;

  const returned = quantity_returned_stock || 0;
  const wasted = quantity_wasted || 0;
  if (!returned && !wasted) return Response.json({ error: "Provide at least one of quantity_returned_stock or quantity_wasted" }, { status: 400 });

  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(params.id).first();
  if (!issue) return Response.json({ error: "Material issue not found" }, { status: 404 });
  if (issue.status === "received") return Response.json({ error: "This material issue is already fully reconciled" }, { status: 400 });

  const alreadyAccounted = issue.quantity_returned_stock + issue.quantity_wasted;
  const thisEvent = returned + wasted;
  if (alreadyAccounted + thisEvent > issue.quantity_issued + 0.001) {
    const stillOutstanding = issue.quantity_issued - alreadyAccounted;
    return Response.json({ error: `Only ${stillOutstanding.toFixed(2)} is still unaccounted for on this issue — can't reconcile more than that` }, { status: 400 });
  }

  await env.DB.prepare(
    "INSERT INTO material_return_events (material_issue_id, quantity_returned_stock, quantity_wasted, destination_site_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(params.id, returned, wasted, destination_site_id || null, notes || null, data.user?.name || "unknown").run();

  let newLotId = null;
  if (returned > 0) {
    const site = destination_site_id || issue.worker_site_id; // default: goes back to wherever it currently is
    const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(issue.lot_id).first();
    newLotId = await nextId(env, "item_lots", "LOT");
    await env.DB.prepare(
      `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, notes)
       VALUES (?, ?, ?, ?, ?, 'transfer_in', ?, ?)`
    ).bind(newLotId, lot.item_id, site, returned, returned, params.id, `Returned unused from ${issue.worker_site_id}`).run();
    await env.DB.prepare(
      "INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, work_order_id, notes, created_by) VALUES (?, ?, 'returned', ?, ?, ?, ?, ?)"
    ).bind(newLotId, lot.item_id, site, returned, issue.work_order_id, `Material return on ${params.id}`, data.user?.name || "system").run();
  }

  const newReturnedTotal = issue.quantity_returned_stock + returned;
  const newWastedTotal = issue.quantity_wasted + wasted;
  const fullyReconciled = newReturnedTotal + newWastedTotal >= issue.quantity_issued - 0.001;

  await env.DB.prepare(
    "UPDATE material_issues SET quantity_returned_stock = ?, quantity_wasted = ?, status = ?, received_at = ? WHERE id = ?"
  ).bind(newReturnedTotal, newWastedTotal, fullyReconciled ? "received" : "partially_returned", fullyReconciled ? new Date().toISOString() : null, params.id).run();

  return Response.json({
    ok: true, lot_id: newLotId, fully_reconciled: fullyReconciled,
    still_unaccounted: Math.round((issue.quantity_issued - newReturnedTotal - newWastedTotal) * 100) / 100,
  });
}
