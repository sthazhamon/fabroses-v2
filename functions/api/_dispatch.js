import { nextId } from "./_ledger.js";
import { reconcileMaterialIssue, resolveOrigin, resolveItemId } from "./_bom.js";

export async function createDispatch(env, { dispatch_type, from_site_id, to_site_id, items, related_work_order_id, related_customer_order_id, related_purchase_order_id, related_sale_id }) {
  const id = await nextId(env, "dispatches", "DSP");
  await env.DB.prepare(
    `INSERT INTO dispatches (id, dispatch_type, from_site_id, to_site_id, related_work_order_id, related_customer_order_id, related_purchase_order_id, related_sale_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_pick')`
  ).bind(id, dispatch_type, from_site_id || null, to_site_id || null, related_work_order_id || null, related_customer_order_id || null, related_purchase_order_id || null, related_sale_id || null).run();

  for (const item of items) {
    await env.DB.prepare("INSERT INTO dispatch_items (dispatch_id, item_id, lot_id, expected_quantity) VALUES (?, ?, ?, ?)")
      .bind(id, item.item_id, item.lot_id || null, item.expected_quantity).run();
  }
  return id;
}

export async function confirmPick(env, dispatchId, { item_id, lot_id, scanned_quantity }) {
  const resolvedItemId = await resolveItemId(env, item_id);
  const { results: pending } = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ? AND scanned_quantity IS NULL").bind(dispatchId).all();
  if (!pending.length) return { error: "Nothing left to pick on this dispatch" };

  // A QR is printed once and encodes the material's stable origin, which
  // survives every future site-to-site transfer even though lot_id itself
  // changes on each move. So a scanned lot that exactly matches wins
  // immediately; otherwise, fall back to comparing origins before giving up.
  const scannedOrigin = lot_id ? await resolveOrigin(env, lot_id) : null;
  let match = pending.find((p) => p.item_id === resolvedItemId && (!lot_id || p.lot_id === lot_id || !p.lot_id));
  if (!match && lot_id && scannedOrigin) {
    for (const p of pending) {
      if (p.item_id !== resolvedItemId || !p.lot_id) continue;
      const candidateOrigin = await resolveOrigin(env, p.lot_id);
      if (candidateOrigin && candidateOrigin === scannedOrigin) { match = p; break; }
    }
  }
  if (!match) return { mismatch: true, error: "Scanned item does not match anything expected on this dispatch" };

  const mismatchQty = scanned_quantity !== match.expected_quantity;
  await env.DB.prepare("UPDATE dispatch_items SET scanned_quantity = ?, mismatch_flag = ? WHERE id = ?").bind(scanned_quantity, mismatchQty ? 1 : 0, match.id).run();
  await env.DB.prepare("UPDATE dispatches SET status = 'picked' WHERE id = ? AND status = 'pending_pick'").bind(dispatchId).run();
  return { ok: true, mismatch: mismatchQty, dispatch_item_id: match.id };
}

// Undoes picking on a dispatch — clears every scanned/mismatch flag and
// drops status back to 'pending_pick', so it reappears in the pending-pick
// queue for a fresh, correct scan. Distinct from cancelling the dispatch
// outright: nothing here is lost, no stock has moved yet at this stage
// (that only happens at ship time), so this is purely undoing data entry.
export async function cancelPick(env, dispatchId) {
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(dispatchId).first();
  if (!dispatch) return { error: "Dispatch not found" };
  if (dispatch.status !== "picked") {
    return { error: `Can't undo a pick — this dispatch is at "${dispatch.status}", not "picked".` };
  }
  await env.DB.prepare("UPDATE dispatch_items SET scanned_quantity = NULL, mismatch_flag = 0 WHERE dispatch_id = ?").bind(dispatchId).run();
  await env.DB.prepare("UPDATE dispatches SET status = 'pending_pick' WHERE id = ?").bind(dispatchId).run();
  return { ok: true };
}

export async function shipDispatch(env, dispatchId, { courier, tracking_id }, actorName) {
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(dispatchId).first();
  if (!dispatch) return { error: "Dispatch not found" };
  if (dispatch.status === "shipped" || dispatch.status === "received") return { error: "Already shipped" };

  const { results: items } = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).all();
  if (items.some((i) => i.scanned_quantity === null)) return { error: "Every item must be picked/confirmed before shipping" };

  for (const item of items) {
    // Customer shipments already had their stock decremented at the moment
    // of billing — this dispatch exists for pick/scan verification and
    // shipment tracking only, not a second inventory movement.
    if (item.lot_id && dispatch.dispatch_type !== "customer_shipment") {
      await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(item.scanned_quantity, item.lot_id).run();
    }
    await env.DB.prepare(
      `INSERT INTO item_movements (lot_id, item_id, event_type, from_site_id, to_site_id, quantity, work_order_id, dispatch_id, notes, created_by)
       VALUES (?, ?, 'transferred_out', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(item.lot_id, item.item_id, dispatch.from_site_id, dispatch.to_site_id, item.scanned_quantity, dispatch.related_work_order_id, dispatchId, `Shipped, in transit (${dispatchId})`, actorName || "system").run();
  }

  await env.DB.prepare("UPDATE dispatches SET status = 'shipped', courier = ?, tracking_id = ?, shipped_at = datetime('now') WHERE id = ?")
    .bind(courier || null, tracking_id || null, dispatchId).run();

  // A customer shipment ends here — there's no internal party on the other
  // end to confirm receipt, so shipping IS the final step, not a halfway point.
  if (dispatch.dispatch_type === "customer_shipment" && dispatch.related_customer_order_id) {
    await env.DB.prepare("UPDATE customer_orders SET status = 'shipped', courier = ?, tracking_id = ?, dispatch_date = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .bind(courier || null, tracking_id || null, dispatch.related_customer_order_id).run();
  }

  if (dispatch.related_work_order_id && dispatch.dispatch_type === "return_shipment") {
    await env.DB.prepare("UPDATE work_orders SET stage = 'Work Shipped', updated_at = datetime('now') WHERE id = ?").bind(dispatch.related_work_order_id).run();
    await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, 'Work Shipped', ?)").bind(dispatch.related_work_order_id, actorName || "system").run();
  }

  return { ok: true };
}

export async function confirmReceive(env, dispatchId, itemConfirmations, actorName, extra) {
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(dispatchId).first();
  if (!dispatch) return { error: "Dispatch not found" };
  if (dispatch.status === "received") return { error: "This was already received — nothing further to do here. If you're seeing this after clicking Confirm, the receipt already went through the first time.", already_done: true };
  if (dispatch.status !== "shipped") return { error: "This dispatch hasn't been shipped yet — nothing to receive" };
  if (dispatch.dispatch_type === "customer_shipment") return { error: "Customer shipments finish at the ship step — there's no separate receipt to confirm here." };

  // Validate every scanned item BEFORE touching anything, so a mismatch on
  // one line never leaves others partially processed. Only checked when a
  // scanned_item_id is actually provided, so this stays backward-compatible
  // with any caller that doesn't scan (e.g. the store confirming a
  // dispatch it already trusts).
  for (const conf of itemConfirmations) {
    if (!conf.scanned_item_id) continue;
    const item = await env.DB.prepare("SELECT * FROM dispatch_items WHERE id = ?").bind(conf.dispatch_item_id).first();
    if (!item) continue;
    const resolvedScannedItemId = await resolveItemId(env, conf.scanned_item_id);
    if (item.item_id !== resolvedScannedItemId) {
      return { error: "Scanned item doesn't match what's expected on this dispatch", mismatch: true };
    }
    if (conf.scanned_lot_id && item.lot_id && item.lot_id !== conf.scanned_lot_id) {
      // A QR is printed once and encodes the material's stable origin,
      // which survives every future site-to-site transfer even though the
      // lot_id itself changes on each move. So an exact lot_id mismatch
      // isn't necessarily wrong - it's only a real mismatch if the two
      // lots don't even share the same origin.
      const [expectedOrigin, scannedOrigin] = await Promise.all([resolveOrigin(env, item.lot_id), resolveOrigin(env, conf.scanned_lot_id)]);
      if (!expectedOrigin || !scannedOrigin || expectedOrigin !== scannedOrigin) {
        return { error: "Scanned lot doesn't match what's expected on this dispatch", mismatch: true };
      }
    }
  }

  const laborCost = (extra && extra.labor_cost) || 0;
  let workOrderClosed = false;
  let finishedLotId = null;
  const reconciliationResults = [];
  const createdLotIds = [];

  for (const conf of itemConfirmations) {
    const item = await env.DB.prepare("SELECT * FROM dispatch_items WHERE id = ?").bind(conf.dispatch_item_id).first();
    if (!item) continue;
    const actuallySent = item.scanned_quantity != null ? item.scanned_quantity : item.expected_quantity;
    const receiveMismatch = actuallySent != null && conf.received_quantity !== actuallySent;
    await env.DB.prepare("UPDATE dispatch_items SET received_quantity = ?, receive_mismatch_flag = ? WHERE id = ?").bind(conf.received_quantity, receiveMismatch ? 1 : 0, item.id).run();
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
      createdLotIds.push({ lot_id: finishedLotId, item_id: item.item_id, resolved_origin: finishedLotId });
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
        // Linkage now lives per LINE, not on the order header — find which
        // line this WO was for, then only flip the order's overall status
        // once every line is either done or never needed a WO in the first place.
        const closedLine = await env.DB.prepare("SELECT * FROM customer_order_items WHERE linked_work_order_id = ?").bind(dispatch.related_work_order_id).first();
        if (closedLine) {
          const { results: siblingLines } = await env.DB.prepare("SELECT coi.*, w.closed_at AS wo_closed_at FROM customer_order_items coi LEFT JOIN work_orders w ON w.id = coi.linked_work_order_id WHERE coi.customer_order_id = ?")
            .bind(closedLine.customer_order_id).all();
          const allReady = siblingLines.every((l) => !l.linked_work_order_id || l.wo_closed_at);
          const currentOrder = await env.DB.prepare("SELECT status FROM customer_orders WHERE id = ?").bind(closedLine.customer_order_id).first();
          if (currentOrder && !["billed", "shipped", "cancelled"].includes(currentOrder.status)) {
            await env.DB.prepare("UPDATE customer_orders SET status = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(allReady ? "ready_to_bill" : "partially_fulfilled", closedLine.customer_order_id).run();
          }
        }
      }
      if (extra && extra.material_reconciliation && extra.material_reconciliation.length) {
        for (const rec of extra.material_reconciliation) {
          try {
            const r = await reconcileMaterialIssue(env, rec.material_issue_id, { ...rec, close_fully: true }, actorName);
            reconciliationResults.push({ material_issue_id: rec.material_issue_id, ...r });
          } catch (e) {
            reconciliationResults.push({ material_issue_id: rec.material_issue_id, error: e.error || e.message });
          }
        }
      }

      continue;
    }

    const newLotId = await nextId(env, "item_lots", "LOT");
    const originForTransfer = await resolveOrigin(env, item.lot_id);
    createdLotIds.push({ lot_id: newLotId, item_id: item.item_id, resolved_origin: originForTransfer || newLotId });
    // Carry the source lot's cost forward, prorated by how much actually
    // moved - otherwise cost silently vanishes every time material
    // physically transfers between sites, even when the source lot had a
    // real, correct cost recorded.
    let transferredCostTotal = null;
    if (item.lot_id) {
      const sourceLot = await env.DB.prepare("SELECT cost_total, quantity_original FROM item_lots WHERE id = ?").bind(item.lot_id).first();
      if (sourceLot && sourceLot.cost_total != null && sourceLot.quantity_original) {
        transferredCostTotal = (sourceLot.cost_total / sourceLot.quantity_original) * conf.received_quantity;
      }
    }
    await env.DB.prepare(
      `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, origin_lot_id, cost_total, notes)
       VALUES (?, ?, ?, ?, ?, 'transfer_in', ?, ?, ?, ?)`
    ).bind(newLotId, item.item_id, dispatch.to_site_id, conf.received_quantity, conf.received_quantity, dispatchId, originForTransfer, transferredCostTotal, `Received via dispatch ${dispatchId}`).run();
    await env.DB.prepare(
      `INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, work_order_id, dispatch_id, notes, created_by)
       VALUES (?, ?, 'transferred_in', ?, ?, ?, ?, ?, ?)`
    ).bind(newLotId, item.item_id, dispatch.to_site_id, conf.received_quantity, dispatch.related_work_order_id, dispatchId, `Confirmed received (${dispatchId})`, actorName || "system").run();

    let creditedAsWorkOrderOutput = false;
    if (dispatch.dispatch_type === "stock_transfer" && !dispatch.related_work_order_id && item.lot_id) {
      const sourceLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(item.lot_id).first();
      if (sourceLot && sourceLot.source_type === "work_order_output" && sourceLot.source_reference) {
        const outputOrder = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(sourceLot.source_reference).first();
        if (outputOrder && !outputOrder.closed_at) {
          const newReceivedTotal = outputOrder.received_quantity_total + conf.received_quantity;
          const nowClosed = newReceivedTotal >= outputOrder.target_quantity;
          await env.DB.prepare(
            "UPDATE work_orders SET received_quantity_total = ?, closed_at = ?, updated_at = datetime('now') WHERE id = ?"
          ).bind(newReceivedTotal, nowClosed ? new Date().toISOString() : null, outputOrder.id).run();

          if (nowClosed) {
            const closedLine = await env.DB.prepare("SELECT * FROM customer_order_items WHERE linked_work_order_id = ?").bind(outputOrder.id).first();
            if (closedLine) {
              const { results: siblingLines } = await env.DB.prepare(
                "SELECT coi.*, w.closed_at AS wo_closed_at FROM customer_order_items coi LEFT JOIN work_orders w ON w.id = coi.linked_work_order_id WHERE coi.customer_order_id = ?"
              ).bind(closedLine.customer_order_id).all();
              const allReady = siblingLines.every((l) => !l.linked_work_order_id || l.wo_closed_at);
              const currentOrder = await env.DB.prepare("SELECT status FROM customer_orders WHERE id = ?").bind(closedLine.customer_order_id).first();
              if (currentOrder && !["billed", "shipped", "cancelled"].includes(currentOrder.status)) {
                await env.DB.prepare("UPDATE customer_orders SET status = ?, updated_at = datetime('now') WHERE id = ?")
                  .bind(allReady ? "ready_to_bill" : "partially_fulfilled", closedLine.customer_order_id).run();
              }
            }
          }
          creditedAsWorkOrderOutput = true;
          if (nowClosed) workOrderClosed = true;
        }
      }
    }

    if (dispatch.dispatch_type === "stock_transfer" && dispatch.related_work_order_id) {
      const order = await env.DB.prepare("SELECT job_type FROM work_orders WHERE id = ?").bind(dispatch.related_work_order_id).first();

      if (order?.job_type === "rework") {
        const reworkIssueId = await nextId(env, "rework_issues", "RWK");
        await env.DB.prepare(
          "INSERT INTO rework_issues (id, work_order_id, lot_id, quantity_issued, worker_site_id, status) VALUES (?, ?, ?, ?, ?, 'with_worker')"
        ).bind(reworkIssueId, dispatch.related_work_order_id, item.lot_id, conf.received_quantity, dispatch.to_site_id).run();
      } else {
        const issueId = await nextId(env, "material_issues", "ISS");
        await env.DB.prepare(
          "INSERT INTO material_issues (id, work_order_id, lot_id, quantity_issued, worker_site_id, status) VALUES (?, ?, ?, ?, ?, 'with_worker')"
        ).bind(issueId, dispatch.related_work_order_id, item.lot_id, conf.received_quantity, dispatch.to_site_id).run();
      }

      await env.DB.prepare("UPDATE work_orders SET stage = 'Material Received', updated_at = datetime('now') WHERE id = ?").bind(dispatch.related_work_order_id).run();
      await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, 'Material Received', ?)").bind(dispatch.related_work_order_id, actorName || "system").run();
    } else if (dispatch.dispatch_type === "stock_transfer" && !dispatch.related_work_order_id && item.lot_id && !creditedAsWorkOrderOutput) {
      // Generic, worker-initiated return of leftover raw material — not
      // tied to any one job. The lot the worker actually holds is a
      // worker-side lot created at confirm-receive time, not the original
      // store lot material_issues.lot_id points at — so matching has to be
      // by item + worker site, not an exact lot id, since that original
      // identity doesn't survive the split. FIFO, oldest first, since
      // there's no job link telling us which specific issue this closes out.
      let remaining = conf.received_quantity;
      const { results: openIssues } = await env.DB.prepare(
        `SELECT mi.* FROM material_issues mi JOIN item_lots l ON l.id = mi.lot_id
         WHERE l.item_id = ? AND mi.worker_site_id = ? AND mi.status != 'received' ORDER BY mi.issued_at ASC, mi.id ASC`
      ).bind(item.item_id, dispatch.from_site_id).all();

      for (const issue of openIssues) {
        if (remaining <= 0) break;
        const stillOutstanding = issue.quantity_issued - issue.quantity_returned_stock - issue.quantity_wasted;
        if (stillOutstanding <= 0) continue;
        const applyNow = Math.min(remaining, stillOutstanding);

        await env.DB.prepare(
          "INSERT INTO material_return_events (material_issue_id, quantity_returned_stock, destination_site_id, notes, created_by) VALUES (?, ?, ?, ?, ?)"
        ).bind(issue.id, applyNow, dispatch.to_site_id, `Auto-reconciled from worker-initiated return via ${dispatchId}`, actorName || "system").run();

        const newReturnedTotal = issue.quantity_returned_stock + applyNow;
        const fullyReconciled = newReturnedTotal + issue.quantity_wasted >= issue.quantity_issued - 0.001;
        await env.DB.prepare("UPDATE material_issues SET quantity_returned_stock = ?, status = ?, received_at = ? WHERE id = ?")
          .bind(newReturnedTotal, fullyReconciled ? "received" : "partially_returned", fullyReconciled ? new Date().toISOString() : null, issue.id).run();

        remaining -= applyNow;
      }
    }
  }

  await env.DB.prepare("UPDATE dispatches SET status = 'received', received_at = datetime('now') WHERE id = ?").bind(dispatchId).run();
  return { ok: true, work_order_closed: workOrderClosed, lot_id: finishedLotId, created_lot_ids: createdLotIds, material_reconciliation_results: reconciliationResults };
}
