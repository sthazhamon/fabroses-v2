// How much of a lot is genuinely available to commit to a NEW dispatch —
// the raw balance minus whatever's already claimed by other dispatches for
// this same lot that haven't shipped yet. Without this, the same physical
// stock could be double-booked across two separate pending dispatches.
export async function genuinelyAvailable(env, lotId) {
  const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lotId).first();
  if (!lot) return null;
  const committedRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(di.expected_quantity),0) AS t FROM dispatch_items di
     JOIN dispatches d ON d.id = di.dispatch_id
     WHERE di.lot_id = ? AND d.status IN ('pending_pick','picked')`
  ).bind(lotId).first();
  const lotOwnAvailable = Math.max(0, lot.quantity_balance - committedRow.t);

  // Reservations (open material_issues) are tracked per item+site, not per
  // specific lot — a job's issue can reference this lot only for lookup
  // purposes while physically drawing from any lot of that item at the
  // site. So the real ceiling is the smaller of: what this specific lot
  // itself can physically supply, and what's genuinely free site-wide
  // once every lot's reservations are accounted for together.
  const { available: siteWideAvailable } = await genuinelyAvailableAtSite(env, lot.item_id, lot.site_id);
  return { lot, available: Math.min(lotOwnAvailable, siteWideAvailable) };
}

async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function reconcileMaterialIssue(env, issueId, { quantity_returned_stock, quantity_wasted, destination_site_id, notes, close_fully }, actorName) {
  const returned = quantity_returned_stock || 0;
  const wasted = quantity_wasted || 0;
  if (!returned && !wasted && !close_fully) throw { status: 400, error: "Provide at least one of quantity_returned_stock or quantity_wasted" };

  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issueId).first();
  if (!issue) throw { status: 404, error: "Material issue not found" };
  if (issue.status === "received") throw { status: 400, error: "This material issue is already fully reconciled" };

  const alreadyAccounted = issue.quantity_returned_stock + issue.quantity_wasted;
  const stillOutstandingBefore = issue.quantity_issued - alreadyAccounted;
  const thisEvent = returned + wasted;
  if (alreadyAccounted + thisEvent > issue.quantity_issued + 0.001) {
    throw { status: 400, error: `Only ${stillOutstandingBefore.toFixed(2)} is still unaccounted for on this issue — can't reconcile more than that` };
  }

  // The issue's own lot_id is a stable reference to the ORIGINAL store lot,
  // for scan-lookup purposes — it's never the worker's actual physical
  // stock, which can be split across several lots or shared with other
  // issues drawing on the same original lot. We only need its item_id here.
  const refLot = await env.DB.prepare("SELECT item_id FROM item_lots WHERE id = ?").bind(issue.lot_id).first();

  // Decrement the worker's real stock for this item via FIFO — the same
  // pattern used everywhere else this system moves stock away from a site.
  const amountLeavingWorkerLot = close_fully ? stillOutstandingBefore : thisEvent;
  if (amountLeavingWorkerLot > 0 && refLot) {
    const { results: workerLots } = await env.DB.prepare(
      "SELECT * FROM item_lots WHERE item_id = ? AND site_id = ? AND quantity_balance > 0 ORDER BY created_at ASC, id ASC"
    ).bind(refLot.item_id, issue.worker_site_id).all();
    const totalAtWorker = workerLots.reduce((s, l) => s + l.quantity_balance, 0);
    if (totalAtWorker < amountLeavingWorkerLot - 0.001) {
      throw { status: 400, error: `Only ${totalAtWorker} left at the worker's site for this item — can't reconcile ${amountLeavingWorkerLot} out of it` };
    }
    let remaining = amountLeavingWorkerLot;
    for (const wl of workerLots) {
      if (remaining <= 0) break;
      const take = Math.min(wl.quantity_balance, remaining);
      await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(take, wl.id).run();
      remaining -= take;
    }
  }

  await env.DB.prepare(
    "INSERT INTO material_return_events (material_issue_id, quantity_returned_stock, quantity_wasted, destination_site_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(issueId, returned, wasted, destination_site_id || null, notes || null, actorName || "unknown").run();

  let newLotId = null;
  if (returned > 0) {
    const site = destination_site_id || issue.worker_site_id;
    newLotId = await nextId(env, "item_lots", "LOT");
    await env.DB.prepare(
      `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, notes)
       VALUES (?, ?, ?, ?, ?, 'transfer_in', ?, ?)`
    ).bind(newLotId, refLot.item_id, site, returned, returned, issueId, `Returned unused from ${issue.worker_site_id}`).run();
    await env.DB.prepare(
      "INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, work_order_id, notes, created_by) VALUES (?, ?, 'returned', ?, ?, ?, ?, ?)"
    ).bind(newLotId, refLot.item_id, site, returned, issue.work_order_id, `Material return on ${issueId}`, actorName || "system").run();
  }

  const newReturnedTotal = issue.quantity_returned_stock + returned;
  const newWastedTotal = issue.quantity_wasted + wasted;
  const fullyReconciled = close_fully || newReturnedTotal + newWastedTotal >= issue.quantity_issued - 0.001;

  await env.DB.prepare(
    "UPDATE material_issues SET quantity_returned_stock = ?, quantity_wasted = ?, status = ?, received_at = ? WHERE id = ?"
  ).bind(newReturnedTotal, newWastedTotal, fullyReconciled ? "received" : "partially_returned", fullyReconciled ? new Date().toISOString() : null, issueId).run();

  return {
    ok: true, lot_id: newLotId, fully_reconciled: fullyReconciled,
    still_unaccounted: fullyReconciled ? 0 : Math.round((issue.quantity_issued - newReturnedTotal - newWastedTotal) * 100) / 100,
  };
}

// BOM-based suggestion for a work order's still-open material issues, given
// the quantity of finished good about to be confirmed — this is what makes
// reconciliation possible to fold directly into confirm-receive, rather than
// a separate step someone has to remember to do later.
export async function suggestMaterialReconciliation(env, workOrderId, confirmedQuantity) {
  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(workOrderId).first();
  if (!order) return [];

  const { results: openIssues } = await env.DB.prepare(
    `SELECT mi.*, i.name AS item_name FROM material_issues mi
     LEFT JOIN item_lots l ON l.id = mi.lot_id LEFT JOIN items i ON i.id = l.item_id
     WHERE mi.work_order_id = ? AND mi.status != 'received'`
  ).bind(workOrderId).all();

  const { results: bomLines } = await env.DB.prepare("SELECT * FROM item_bom WHERE finished_item_id = ?").bind(order.intended_item_id).all();
  const bomByItem = {};
  for (const line of bomLines) bomByItem[line.raw_material_item_id] = line.quantity_required;

  const suggestions = [];
  for (const issue of openIssues) {
    const lot = await env.DB.prepare("SELECT item_id FROM item_lots WHERE id = ?").bind(issue.lot_id).first();
    const perUnit = lot ? bomByItem[lot.item_id] : undefined;
    const stillOpen = issue.quantity_issued - issue.quantity_returned_stock - issue.quantity_wasted;
    const expectedConsumption = perUnit != null ? perUnit * confirmedQuantity : null;
    const suggestedReturn = expectedConsumption != null ? Math.max(0, stillOpen - expectedConsumption) : stillOpen;
    suggestions.push({
      material_issue_id: issue.id, item_name: issue.item_name, quantity_issued: issue.quantity_issued, still_open: Math.round(stillOpen * 100) / 100,
      bom_expected_consumption: expectedConsumption != null ? Math.round(expectedConsumption * 100) / 100 : null,
      suggested_quantity_returned_stock: Math.round(suggestedReturn * 100) / 100,
    });
  }
  return suggestions;
}
async function stockAtSite(env, itemId, siteId) {
  const { results } = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ? AND quantity_balance > 0 ORDER BY created_at ASC, id ASC").bind(itemId, siteId).all();
  return results;
}

// How much raw stock at a site is genuinely free to reserve for a NEW job —
// the physical balance minus whatever's already reserved by OTHER open
// (not yet consumed) material issues for that same item at that site.
// Without this, two jobs could both see the same stock as "available"
// and both reserve it, since reservation no longer decrements immediately.
export async function genuinelyAvailableAtSite(env, itemId, siteId) {
  const workerLots = await stockAtSite(env, itemId, siteId);
  const rawBalance = workerLots.reduce((s, l) => s + l.quantity_balance, 0);
  const { results: openIssues } = await env.DB.prepare(
    `SELECT mi.* FROM material_issues mi JOIN item_lots l ON l.id = mi.lot_id
     WHERE l.item_id = ? AND mi.worker_site_id = ? AND mi.status != 'received'`
  ).bind(itemId, siteId).all();
  const alreadyReserved = openIssues.reduce((s, i) => s + (i.quantity_issued - i.quantity_returned_stock - i.quantity_wasted), 0);
  return { rawBalance, available: Math.max(0, rawBalance - alreadyReserved), workerLots };
}

// Consumes FIFO across whatever lots are available at a site, up to
// quantity — returns however much was actually taken from where. Never
// throws on a shortfall; caller decides what "not enough" means.
async function consumeFifo(env, lots, quantity) {
  let remaining = quantity;
  const taken = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.quantity_balance, remaining);
    if (take <= 0) continue;
    await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(take, lot.id).run();
    taken.push({ lot_id: lot.id, quantity: take });
    remaining -= take;
  }
  return { taken, shortfall: Math.max(0, remaining) };
}

// Returns the BOM lines for an item with the suggested quantity for a given
// target output quantity, plus current stock at the worker's site and the store.
export async function suggestBomLines(env, intendedItemId, targetQuantity, workerSiteId) {
  const { results: bomLines } = await env.DB.prepare(
    "SELECT b.*, i.name AS raw_material_name, i.unit_of_measure FROM item_bom b LEFT JOIN items i ON i.id = b.raw_material_item_id WHERE b.finished_item_id = ?"
  ).bind(intendedItemId).all();

  const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();
  const suggestions = [];
  for (const line of bomLines) {
    const suggestedQty = line.quantity_required * targetQuantity;
    const workerStockRow = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ? AND site_id = ?").bind(line.raw_material_item_id, workerSiteId).first();
    const storeStockRow = storeSite ? await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ? AND site_id = ?").bind(line.raw_material_item_id, storeSite.id).first() : { t: 0 };
    suggestions.push({
      raw_material_item_id: line.raw_material_item_id, raw_material_name: line.raw_material_name, unit_of_measure: line.unit_of_measure,
      quantity_required_per_unit: line.quantity_required, suggested_quantity: suggestedQty,
      worker_stock: workerStockRow.t, store_stock: storeStockRow.t,
    });
  }
  return suggestions;
}

// Actually fulfills each line: worker's own stock first, then the store
// (possibly across several lots), otherwise leaves it genuinely unmet —
// the existing dispatch-queue detection already surfaces that case.
export async function fulfillBomLines(env, { workOrderId, workerSiteId, lines, actorName }) {
  const results = [];
  const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();

  for (const line of lines) {
    const quantity = line.quantity;
    if (!quantity) continue;

    const { available: workerAvailable, workerLots } = await genuinelyAvailableAtSite(env, line.raw_material_item_id, workerSiteId);

    if (workerAvailable >= quantity) {
      // Already at the worker's site from a previous job — no physical
      // move needed. This reserves it via a real material issue (which is
      // what the scan-verification gate checks against), but doesn't
      // decrement the balance yet — actual consumption happens later, at
      // Mark Job Done, matching every other raw-material consumption point.
      const issueId = await nextId(env, "material_issues", "ISS");
      await env.DB.prepare("INSERT INTO material_issues (id, work_order_id, lot_id, quantity_issued, worker_site_id, status) VALUES (?, ?, ?, ?, ?, 'with_worker')")
        .bind(issueId, workOrderId, workerLots[0].id, quantity, workerSiteId).run();
      results.push({ raw_material_item_id: line.raw_material_item_id, resolution: "already_at_worker", quantity });
      continue;
    }

    if (storeSite) {
      const storeLots = await stockAtSite(env, line.raw_material_item_id, storeSite.id);
      const storeAvailable = storeLots.reduce((s, l) => s + l.quantity_balance, 0);
      if (storeAvailable >= quantity) {
        // Reverse the (insufficient) worker-side consumption check — nothing
        // was actually taken from the worker above since availability was short.
        const { taken: storeTaken } = await consumeFifoPreview(storeLots, quantity);
        const dispatchId = await nextId(env, "dispatches", "DSP");
        await env.DB.prepare(
          "INSERT INTO dispatches (id, dispatch_type, from_site_id, to_site_id, related_work_order_id, status) VALUES (?, 'stock_transfer', ?, ?, ?, 'pending_pick')"
        ).bind(dispatchId, storeSite.id, workerSiteId, workOrderId).run();
        for (const t of storeTaken) {
          await env.DB.prepare("INSERT INTO dispatch_items (dispatch_id, item_id, lot_id, expected_quantity) VALUES (?, ?, ?, ?)")
            .bind(dispatchId, line.raw_material_item_id, t.lot_id, t.quantity).run();
        }
        results.push({ raw_material_item_id: line.raw_material_item_id, resolution: "dispatch_created", quantity, dispatch_id: dispatchId, lots_used: storeTaken.length });
        continue;
      }
    }

    // Neither the worker nor the store has enough — this line stays
    // genuinely unmet. No action taken; it surfaces naturally through the
    // existing "material to workers" dispatch-queue detection.
    results.push({ raw_material_item_id: line.raw_material_item_id, resolution: "unmet", quantity });
  }

  return results;
}

// Preview-only FIFO selection against the store's lots — doesn't actually
// decrement anything, since the real decrement happens at ship time via
// the normal two-step dispatch flow, not at WO creation.
function consumeFifoPreview(lots, quantity) {
  let remaining = quantity;
  const taken = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.quantity_balance, remaining);
    if (take <= 0) continue;
    taken.push({ lot_id: lot.id, quantity: take });
    remaining -= take;
  }
  return { taken, shortfall: Math.max(0, remaining) };
}
