export async function onRequestPost({ env, params }) {
  const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(params.id).first();
  if (!lot) return Response.json({ error: "Lot not found" }, { status: 404 });
  if (lot.quantity_balance !== lot.quantity_original) {
    return Response.json({ error: `Can't void — only ${lot.quantity_balance} of the original ${lot.quantity_original} is still there. The rest has already been used, sold, or moved elsewhere.` }, { status: 400 });
  }

  let handled = false;

  // Case 1: created by receiving against a purchase order line.
  if (lot.source_type === "purchase_order") {
    const line = await env.DB.prepare("SELECT * FROM purchase_order_items WHERE purchase_order_id = ? AND item_id = ?").bind(lot.source_reference, lot.item_id).first();
    if (line) {
      const newReceived = Math.max(0, line.quantity_received - lot.quantity_original);
      // A line that was deliberately short-closed stays that way — voiding
      // a receipt shouldn't silently undo that separate, deliberate action.
      const newStatus = line.status === "short_closed" ? "short_closed" : newReceived >= line.quantity_ordered ? "received" : newReceived > 0 ? "partially_received" : "ordered";
      await env.DB.prepare("UPDATE purchase_order_items SET quantity_received = ?, status = ? WHERE id = ?").bind(newReceived, newStatus, line.id).run();
      handled = true;
    }
  }

  // Case 2: created via a dispatch confirm-receive — reverse whatever work
  // order progress it credited, if any. The work order link comes from
  // the ORIGINAL shipped lot (via the dispatch_item), not from the
  // movement record itself — this mirrors exactly how confirmReceive
  // determines which work order to credit in the first place.
  const movementRow = await env.DB.prepare(
    "SELECT * FROM item_movements WHERE lot_id = ? AND dispatch_id IS NOT NULL AND event_type = 'transferred_in' LIMIT 1"
  ).bind(lot.id).first();
  if (movementRow) {
    handled = true;
    const dispatchItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ? AND item_id = ?").bind(movementRow.dispatch_id, lot.item_id).first();
    if (dispatchItem && dispatchItem.lot_id) {
      const sourceLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(dispatchItem.lot_id).first();
      if (sourceLot && sourceLot.source_type === "work_order_output" && sourceLot.source_reference) {
        const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(sourceLot.source_reference).first();
        if (order && order.closed_at) {
          const newReceivedTotal = Math.max(0, order.received_quantity_total - lot.quantity_original);
          await env.DB.prepare("UPDATE work_orders SET received_quantity_total = ?, closed_at = NULL WHERE id = ?").bind(newReceivedTotal, order.id).run();
        }
      }
    }
  }

  if (!handled) {
    return Response.json({ error: "This lot wasn't created by a purchase order receipt or a dispatch confirmation — voiding isn't supported for it here." }, { status: 400 });
  }

  await env.DB.prepare(
    "UPDATE item_lots SET quantity_balance = 0, quantity_original = 0, notes = COALESCE(notes || ' ', '') || '[VOIDED — wrong item/entry]' WHERE id = ?"
  ).bind(lot.id).run();

  return Response.json({ ok: true });
}
