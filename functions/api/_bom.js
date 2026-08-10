async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

async function stockAtSite(env, itemId, siteId) {
  const { results } = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ? AND quantity_balance > 0 ORDER BY created_at ASC").bind(itemId, siteId).all();
  return results;
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

    const workerLots = await stockAtSite(env, line.raw_material_item_id, workerSiteId);
    const workerAvailable = workerLots.reduce((s, l) => s + l.quantity_balance, 0);

    if (workerAvailable >= quantity) {
      // Already at the worker's site from a previous job — no physical
      // move needed, but it still becomes a real, reconcilable material
      // issue, exactly as if it had just arrived.
      const { taken } = await consumeFifo(env, workerLots, quantity);
      const issueId = await nextId(env, "material_issues", "ISS");
      await env.DB.prepare("INSERT INTO material_issues (id, work_order_id, lot_id, quantity_issued, worker_site_id, status) VALUES (?, ?, ?, ?, ?, 'with_worker')")
        .bind(issueId, workOrderId, taken[0].lot_id, quantity, workerSiteId).run();
      for (const t of taken) {
        await env.DB.prepare("INSERT INTO item_movements (lot_id, item_id, event_type, from_site_id, quantity, work_order_id, notes, created_by) VALUES (?, ?, 'consumed', ?, ?, ?, ?, ?)")
          .bind(t.lot_id, line.raw_material_item_id, workerSiteId, t.quantity, workOrderId, "Already at worker's site, drawn against this job", actorName || "system").run();
      }
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
