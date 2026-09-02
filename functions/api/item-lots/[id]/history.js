export async function onRequestGet({ env, params }) {
  const lot = await env.DB.prepare("SELECT l.*, i.name AS item_name, i.item_code FROM item_lots l LEFT JOIN items i ON i.id = l.item_id WHERE l.id = ?").bind(params.id).first();
  if (!lot) return Response.json({ error: "Lot not found" }, { status: 404 });

  const { results: movements } = await env.DB.prepare(
    `SELECT m.*, fs.name AS from_site_name, ts.name AS to_site_name, w.description AS work_order_description
     FROM item_movements m
     LEFT JOIN sites fs ON fs.id = m.from_site_id
     LEFT JOIN sites ts ON ts.id = m.to_site_id
     LEFT JOIN work_orders w ON w.id = m.work_order_id
     WHERE m.lot_id = ?
     ORDER BY m.created_at ASC`
  ).bind(params.id).all();

  const { results: reworkCycles } = await env.DB.prepare(
    `SELECT ri.*, w.description AS work_order_description, s.name AS worker_site_name
     FROM rework_issues ri
     LEFT JOIN work_orders w ON w.id = ri.work_order_id
     LEFT JOIN sites s ON s.id = ri.worker_site_id
     WHERE ri.lot_id = ?
     ORDER BY ri.issued_at ASC`
  ).bind(params.id).all();

  for (const cycle of reworkCycles) {
    const { results: events } = await env.DB.prepare("SELECT * FROM rework_return_events WHERE rework_issue_id = ? ORDER BY created_at ASC").bind(cycle.id).all();
    cycle.events = events;
  }

  // BOM-level traceability: if this lot was produced by a work order, show
  // which raw material lots were actually consumed to make it - previously
  // the history only ever showed this lot's own movements, never what it
  // was made from.
  let bomConsumption = [];
  if (lot.source_type === "work_order_output" && lot.source_reference) {
    const { results: consumed } = await env.DB.prepare(
      `SELECT m.lot_id, m.quantity, m.created_at, i.name AS item_name, i.item_code,
              rl.source_type AS raw_lot_source_type, rl.source_reference AS raw_lot_source_reference
       FROM item_movements m
       LEFT JOIN items i ON i.id = m.item_id
       LEFT JOIN item_lots rl ON rl.id = m.lot_id
       WHERE m.work_order_id = ? AND m.event_type = 'consumed'
       ORDER BY m.created_at ASC`
    ).bind(lot.source_reference).all();
    bomConsumption = consumed;
  }

  // Origin-chain traceability: a lot that arrived via a transfer is a NEW
  // row with its own id, but origin_lot_id already tracks the very first
  // lot in the chain (e.g. the original PO receipt at the site it first
  // entered stock). That lot's own movements were never surfaced here
  // before, so provenance beyond this specific hop was invisible.
  let originHistory = null;
  if (lot.origin_lot_id && lot.origin_lot_id !== lot.id) {
    const originLot = await env.DB.prepare("SELECT l.*, i.name AS item_name, i.item_code FROM item_lots l LEFT JOIN items i ON i.id = l.item_id WHERE l.id = ?").bind(lot.origin_lot_id).first();
    if (originLot) {
      const { results: originMovements } = await env.DB.prepare(
        `SELECT m.*, fs.name AS from_site_name, ts.name AS to_site_name
         FROM item_movements m LEFT JOIN sites fs ON fs.id = m.from_site_id LEFT JOIN sites ts ON ts.id = m.to_site_id
         WHERE m.lot_id = ? ORDER BY m.created_at ASC`
      ).bind(lot.origin_lot_id).all();
      let originBomConsumption = [];
      if (originLot.source_type === "work_order_output" && originLot.source_reference) {
        const { results: originConsumed } = await env.DB.prepare(
          `SELECT m.lot_id, m.quantity, m.created_at, i.name AS item_name, i.item_code
           FROM item_movements m LEFT JOIN items i ON i.id = m.item_id
           WHERE m.work_order_id = ? AND m.event_type = 'consumed'
           ORDER BY m.created_at ASC`
        ).bind(originLot.source_reference).all();
        originBomConsumption = originConsumed;
      }
      originHistory = { lot: originLot, movements: originMovements, bom_consumption: originBomConsumption };
    }
  }

  return Response.json({ lot, movements, rework_cycles: reworkCycles, bom_consumption: bomConsumption, origin_history: originHistory });
}
