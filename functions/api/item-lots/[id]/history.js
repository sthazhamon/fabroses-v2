export async function onRequestGet({ env, params }) {
  // Resolve whatever was passed in to its own stable origin first - this
  // makes the endpoint correct regardless of whether params.id is the
  // stable origin itself or one of its per-site children, rather than only
  // working when the exact right one is passed in.
  const inputLot = await env.DB.prepare("SELECT id, origin_lot_id FROM item_lots WHERE id = ?").bind(params.id).first();
  if (!inputLot) return Response.json({ error: "Lot not found" }, { status: 404 });
  const stableOrigin = inputLot.origin_lot_id || inputLot.id;

  // Every actual per-site inventory row that's ever shared this origin
  // (including the origin row itself) is found here, so the full journey
  // is visible in one place regardless of how many hops it's been through.
  const { results: relatedLots } = await env.DB.prepare(
    `SELECT l.*, i.name AS item_name, i.item_code
     FROM item_lots l LEFT JOIN items i ON i.id = l.item_id
     WHERE l.id = ? OR l.origin_lot_id = ?
     ORDER BY l.id ASC`
  ).bind(stableOrigin, stableOrigin).all();

  if (!relatedLots.length) return Response.json({ error: "Lot not found" }, { status: 404 });

  const originLot = relatedLots.find((l) => l.id === stableOrigin) || relatedLots[0];
  const lotIds = relatedLots.map((l) => l.id);
  const placeholders = lotIds.map(() => "?").join(",");

  // Every movement across every one of those rows, combined and sorted
  // chronologically - this is the full journey, not just one segment of it.
  const { results: movements } = await env.DB.prepare(
    `SELECT m.*, fs.name AS from_site_name, ts.name AS to_site_name, w.description AS work_order_description
     FROM item_movements m
     LEFT JOIN sites fs ON fs.id = m.from_site_id
     LEFT JOIN sites ts ON ts.id = m.to_site_id
     LEFT JOIN work_orders w ON w.id = m.work_order_id
     WHERE m.lot_id IN (${placeholders})
     ORDER BY m.created_at ASC`
  ).bind(...lotIds).all();

  // Where this material currently sits, right now, across every site it's
  // split across - each still-open row is its own line, per site.
  const { results: currentSites } = await env.DB.prepare(
    `SELECT l.id AS lot_id, l.site_id, s.name AS site_name, l.quantity_balance
     FROM item_lots l LEFT JOIN sites s ON s.id = l.site_id
     WHERE l.id IN (${placeholders}) AND l.quantity_balance > 0
     ORDER BY s.name ASC`
  ).bind(...lotIds).all();

  const { results: reworkCycles } = await env.DB.prepare(
    `SELECT ri.*, w.description AS work_order_description, s.name AS worker_site_name
     FROM rework_issues ri
     LEFT JOIN work_orders w ON w.id = ri.work_order_id
     LEFT JOIN sites s ON s.id = ri.worker_site_id
     WHERE ri.lot_id IN (${placeholders})
     ORDER BY ri.issued_at ASC`
  ).bind(...lotIds).all();

  for (const cycle of reworkCycles) {
    const { results: events } = await env.DB.prepare("SELECT * FROM rework_return_events WHERE rework_issue_id = ? ORDER BY created_at ASC").bind(cycle.id).all();
    cycle.events = events;
  }

  // BOM-level traceability: any of the related rows might be the one
  // actually produced by a work order (not necessarily the origin row
  // itself, if the finished good was later split and transferred) - check
  // all of them, not just one.
  let bomConsumption = [];
  for (const relatedLot of relatedLots) {
    if (relatedLot.source_type === "work_order_output" && relatedLot.source_reference) {
      const { results: consumed } = await env.DB.prepare(
        `SELECT m.lot_id, m.quantity, m.created_at, i.name AS item_name, i.item_code, rl.origin_lot_id
         FROM item_movements m LEFT JOIN items i ON i.id = m.item_id LEFT JOIN item_lots rl ON rl.id = m.lot_id
         WHERE m.work_order_id = ? AND m.event_type = 'consumed'
         ORDER BY m.created_at ASC`
      ).bind(relatedLot.source_reference).all();
      for (const c of consumed) c.resolved_origin = c.origin_lot_id || c.lot_id;
      bomConsumption = bomConsumption.concat(consumed);
    }
  }

  const totalBalance = currentSites.reduce((s, r) => s + r.quantity_balance, 0);

  return Response.json({
    lot: originLot, item_name: originLot.item_name, item_code: originLot.item_code,
    current_sites: currentSites, total_balance: totalBalance,
    movements, rework_cycles: reworkCycles, bom_consumption: bomConsumption,
  });
}
