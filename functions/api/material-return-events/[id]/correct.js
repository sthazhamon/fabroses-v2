async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  const { corrected_returned_stock, corrected_wasted } = body;
  if (corrected_returned_stock == null || corrected_wasted == null) {
    return Response.json({ error: "corrected_returned_stock and corrected_wasted are both required — enter what the figures should have been" }, { status: 400 });
  }

  const event = await env.DB.prepare("SELECT * FROM material_return_events WHERE id = ?").bind(params.id).first();
  if (!event) return Response.json({ error: "Return event not found" }, { status: 404 });
  if (event.corrected_at) return Response.json({ error: "This entry has already been corrected once — a further correction isn't supported" }, { status: 400 });

  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(event.material_issue_id).first();
  if (!issue) return Response.json({ error: "The related material issue no longer exists" }, { status: 404 });

  const deltaReturned = corrected_returned_stock - event.quantity_returned_stock;
  const deltaWasted = corrected_wasted - event.quantity_wasted;

  if (deltaReturned === 0 && deltaWasted === 0) {
    return Response.json({ error: "Nothing to correct — the new figures match what's already on record" }, { status: 400 });
  }

  // The returned-stock side created a real lot. Adjust that same lot's
  // balance directly rather than moving stock somewhere else.
  if (deltaReturned !== 0) {
    if (!event.created_lot_id) {
      return Response.json({ error: "This entry never created a returned-stock lot — there's nothing to adjust on that side." }, { status: 400 });
    }
    const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(event.created_lot_id).first();
    if (!lot) return Response.json({ error: "The lot this entry created no longer exists" }, { status: 400 });
    if (deltaReturned < 0 && lot.quantity_balance < -deltaReturned - 0.001) {
      return Response.json({ error: `Can't correct — only ${lot.quantity_balance} of the ${event.quantity_returned_stock} originally returned is still there. The rest has already been used, shipped, or sold elsewhere.` }, { status: 400 });
    }
    await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance + ?, quantity_original = quantity_original + ? WHERE id = ?")
      .bind(deltaReturned, deltaReturned, lot.id).run();
  }

  // The wasted side never created a lot — it just left the worker's stock
  // outright. A correction here adjusts the worker's own current stock
  // directly: crediting it back if waste is being reduced (some of it
  // was never actually wasted), or decrementing further if increased.
  if (deltaWasted !== 0) {
    const refLot = await env.DB.prepare("SELECT item_id FROM item_lots WHERE id = ?").bind(issue.lot_id).first();
    if (deltaWasted < 0) {
      const creditLotId = await nextId(env, "item_lots", "LOT");
      await env.DB.prepare(
        `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, notes)
         VALUES (?, ?, ?, ?, ?, 'correction', ?, ?)`
      ).bind(creditLotId, refLot.item_id, issue.worker_site_id, -deltaWasted, -deltaWasted, `RETEVT-${event.id}`, `Correction: waste reduced on return event ${event.id}`).run();
    } else {
      const { results: workerLots } = await env.DB.prepare(
        "SELECT * FROM item_lots WHERE item_id = ? AND site_id = ? AND quantity_balance > 0 ORDER BY created_at ASC, id ASC"
      ).bind(refLot.item_id, issue.worker_site_id).all();
      const totalAtWorker = workerLots.reduce((s, l) => s + l.quantity_balance, 0);
      if (totalAtWorker < deltaWasted - 0.001) {
        return Response.json({ error: `Can't correct — only ${totalAtWorker} left at the worker's site, can't mark ${deltaWasted} more as wasted than that.` }, { status: 400 });
      }
      let remaining = deltaWasted;
      for (const lot of workerLots) {
        if (remaining <= 0) break;
        const take = Math.min(lot.quantity_balance, remaining);
        await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(take, lot.id).run();
        remaining -= take;
      }
    }
  }

  await env.DB.prepare("UPDATE material_return_events SET corrected_at = datetime('now') WHERE id = ?").bind(event.id).run();

  const newReturnedTotal = issue.quantity_returned_stock + deltaReturned;
  const newWastedTotal = issue.quantity_wasted + deltaWasted;
  const fullyReconciled = newReturnedTotal + newWastedTotal >= issue.quantity_issued - 0.001;
  const newStatus = fullyReconciled ? "received" : (newReturnedTotal + newWastedTotal > 0 ? "partially_returned" : "with_worker");
  await env.DB.prepare("UPDATE material_issues SET quantity_returned_stock = ?, quantity_wasted = ?, status = ? WHERE id = ?")
    .bind(newReturnedTotal, newWastedTotal, newStatus, issue.id).run();

  await env.DB.prepare(
    "INSERT INTO material_return_events (material_issue_id, quantity_returned_stock, quantity_wasted, notes, created_by) VALUES (?, ?, ?, ?, ?)"
  ).bind(issue.id, deltaReturned, deltaWasted, `Correction of return event #${event.id}`, data.user?.name || "unknown").run();

  return Response.json({ ok: true, delta_returned: deltaReturned, delta_wasted: deltaWasted, new_issue_status: newStatus });
}
