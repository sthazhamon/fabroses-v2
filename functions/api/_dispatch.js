import { nextId } from "./_ledger.js";

export async function createDispatch(env, { dispatch_type, from_site_id, to_site_id, items, related_work_order_id, related_customer_order_id, related_purchase_order_id }) {
  const id = await nextId(env, "dispatches", "DSP");
  await env.DB.prepare(
    `INSERT INTO dispatches (id, dispatch_type, from_site_id, to_site_id, related_work_order_id, related_customer_order_id, related_purchase_order_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_pick')`
  ).bind(id, dispatch_type, from_site_id || null, to_site_id || null, related_work_order_id || null, related_customer_order_id || null, related_purchase_order_id || null).run();

  for (const item of items) {
    await env.DB.prepare("INSERT INTO dispatch_items (dispatch_id, item_id, lot_id, expected_quantity) VALUES (?, ?, ?, ?)")
      .bind(id, item.item_id, item.lot_id || null, item.expected_quantity).run();
  }
  return id;
}

export async function confirmPick(env, dispatchId, { item_id, lot_id, scanned_quantity }) {
  const { results: pending } = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ? AND scanned_quantity IS NULL").bind(dispatchId).all();
  if (!pending.length) return { error: "Nothing left to pick on this dispatch" };
  const match = pending.find((p) => p.item_id === item_id && (!lot_id || p.lot_id === lot_id || !p.lot_id));
  if (!match) return { mismatch: true, error: "Scanned item does not match anything expected on this dispatch" };

  const mismatchQty = scanned_quantity !== match.expected_quantity;
  await env.DB.prepare("UPDATE dispatch_items SET scanned_quantity = ?, mismatch_flag = ? WHERE id = ?").bind(scanned_quantity, mismatchQty ? 1 : 0, match.id).run();
  await env.DB.prepare("UPDATE dispatches SET status = 'picked' WHERE id = ? AND status = 'pending_pick'").bind(dispatchId).run();
  return { ok: true, mismatch: mismatchQty, dispatch_item_id: match.id };
}

export async function shipDispatch(env, dispatchId, { courier, tracking_id }, actorName) {
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(dispatchId).first();
  if (!dispatch) return { error: "Dispatch not found" };
  if (dispatch.status === "shipped" || dispatch.status === "received") return { error: "Already shipped" };

  const { results: items } = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).all();
  if (items.some((i) => i.scanned_quantity === null)) return { error: "Every item must be picked/confirmed before shipping" };

  for (const item of items) {
    if (item.lot_id) {
      await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(item.scanned_quantity, item.lot_id).run();
    }
    await env.DB.prepare(
      `INSERT INTO item_movements (lot_id, item_id, event_type, from_site_id, to_site_id, quantity, work_order_id, dispatch_id, notes, created_by)
       VALUES (?, ?, 'transferred_out', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(item.lot_id, item.item_id, dispatch.from_site_id, dispatch.to_site_id, item.scanned_quantity, dispatch.related_work_order_id, dispatchId, `Shipped, in transit (${dispatchId})`, actorName || "system").run();
  }

  await env.DB.prepare("UPDATE dispatches SET status = 'shipped', courier = ?, tracking_id = ?, shipped_at = datetime('now') WHERE id = ?")
    .bind(courier || null, tracking_id || null, dispatchId).run();

  if (dispatch.related_work_order_id && dispatch.dispatch_type === "return_shipment") {
    await env.DB.prepare("UPDATE work_orders SET stage = 'Work Shipped', updated_at = datetime('now') WHERE id = ?").bind(dispatch.related_work_order_id).run();
    await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, 'Work Shipped', ?)").bind(dispatch.related_work_order_id, actorName || "system").run();
  }

  return { ok: true };
}

export async function confirmReceive(env, dispatchId, itemConfirmations, actorName, extra) {
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(dispatchId).first();
  if (!dispatch) return { error: "Dispatch not found" };
  if (dispatch.status !== "shipped") return { error: "This dispatch hasn't been shipped yet — nothing to receive" };

  const laborCost = (extra && extra.labor_cost) || 0;
  let workOrderClosed = false;
  let finishedLotId = null;

  for (const conf of itemConfirmations) {
    const item = await env.DB.prepare("SELECT * FROM dispatch_items WHERE id = ?").bind(conf.dispatch_item_id).first();
    if (!item) continue;
    await env.DB.prepare("UPDATE dispatch_items SET received_quantity = ? WHERE id = ?").bind(conf.received_quantity, item.id).run();
    if (!dispatch.to_site_id || conf.received_quantity <= 0) continue;

    // Finished good coming back from a worker — this is the moment stock
    // actually gets credited, cost gets computed, and the work order's
    // progress updates. Everything before this point was just "in transit."
    if (dispatch.dispatch_type === "return_shipment" && dispatch.related_work_order_id) {
      const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(dispatch.related_work_order_id).first();

      const { results: issues } = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(dispatch.related_work_order_id).all();
      let rawCost = 0;
      for (const issue of issues) {
        const consumed = issue.quantity_issued - issue.quantity_returned_stock - issue.quantity_wasted;
        if (consumed <= 0) continue;
        const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(issue.lot_id).first();
        const costPerUnit = lot && lot.cost_total && lot.quantity_original ? lot.cost_total / lot.quantity_original : 0;
        rawCost += costPerUnit * consumed;
      }

      finishedLotId = await nextId(env, "item_lots", "LOT");
      await env.DB.prepare(
        `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, cost_total, notes)
         VALUES (?, ?, ?, ?, ?, 'work_order_output', ?, ?, ?)`
      ).bind(finishedLotId, item.item_id, dispatch.to_site_id, conf.received_quantity, conf.received_quantity, dispatch.related_work_order_id, rawCost + laborCost, `Received via ${dispatchId}`).run();
      await env.DB.prepare(
        `INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, work_order_id, dispatch_id, notes, created_by)
         VALUES (?, ?, 'returned', ?, ?, ?, ?, ?, ?)`
      ).bind(finishedLotId, item.item_id, dispatch.to_site_id, conf.received_quantity, dispatch.related_work_order_id, dispatchId, `Confirmed received (${dispatchId})`, actorName || "system").run();

      const newReceivedTotal = order.received_quantity_total + conf.received_quantity;
      workOrderClosed = newReceivedTotal >= order.target_quantity;
      await env.DB.prepare(
        `UPDATE work_orders SET received_quantity_total = ?, output_item_id = ?, labor_cost = COALESCE(labor_cost, 0) + ?, closed_at = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(newReceivedTotal, item.item_id, laborCost, workOrderClosed ? new Date().toISOString() : null, dispatch.related_work_order_id).run();

      if (workOrderClosed) {
        await env.DB.prepare(
          "UPDATE customer_orders SET status = 'ready_to_bill', updated_at = datetime('now') WHERE linked_work_order_id = ? AND status = 'awaiting_material'"
        ).bind(dispatch.related_work_order_id).run();
      }
      continue;
    }

    const newLotId = await nextId(env, "item_lots", "LOT");
    await env.DB.prepare(
      `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, notes)
       VALUES (?, ?, ?, ?, ?, 'transfer_in', ?, ?)`
    ).bind(newLotId, item.item_id, dispatch.to_site_id, conf.received_quantity, conf.received_quantity, dispatchId, `Received via dispatch ${dispatchId}`).run();
    await env.DB.prepare(
      `INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, work_order_id, dispatch_id, notes, created_by)
       VALUES (?, ?, 'transferred_in', ?, ?, ?, ?, ?, ?)`
    ).bind(newLotId, item.item_id, dispatch.to_site_id, conf.received_quantity, dispatch.related_work_order_id, dispatchId, `Confirmed received (${dispatchId})`, actorName || "system").run();

    if (dispatch.dispatch_type === "stock_transfer" && dispatch.related_work_order_id) {
      const issueId = await nextId(env, "material_issues", "ISS");
      await env.DB.prepare(
        "INSERT INTO material_issues (id, work_order_id, lot_id, quantity_issued, worker_site_id, status) VALUES (?, ?, ?, ?, ?, 'with_worker')"
      ).bind(issueId, dispatch.related_work_order_id, item.lot_id, conf.received_quantity, dispatch.to_site_id).run();

      await env.DB.prepare("UPDATE work_orders SET stage = 'Material Received', updated_at = datetime('now') WHERE id = ?").bind(dispatch.related_work_order_id).run();
      await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, 'Material Received', ?)").bind(dispatch.related_work_order_id, actorName || "system").run();
    }
  }

  await env.DB.prepare("UPDATE dispatches SET status = 'received', received_at = datetime('now') WHERE id = ?").bind(dispatchId).run();
  return { ok: true, work_order_closed: workOrderClosed, lot_id: finishedLotId };
}
