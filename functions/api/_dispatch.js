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
  return { ok: true };
}

export async function confirmReceive(env, dispatchId, itemConfirmations, actorName) {
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(dispatchId).first();
  if (!dispatch) return { error: "Dispatch not found" };
  if (dispatch.status !== "shipped") return { error: "This dispatch hasn't been shipped yet — nothing to receive" };

  for (const conf of itemConfirmations) {
    const item = await env.DB.prepare("SELECT * FROM dispatch_items WHERE id = ?").bind(conf.dispatch_item_id).first();
    if (!item) continue;
    await env.DB.prepare("UPDATE dispatch_items SET received_quantity = ? WHERE id = ?").bind(conf.received_quantity, item.id).run();

    if (dispatch.to_site_id && conf.received_quantity > 0) {
      const newLotId = await nextId(env, "item_lots", "LOT");
      await env.DB.prepare(
        `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, notes)
         VALUES (?, ?, ?, ?, ?, 'transfer_in', ?, ?)`
      ).bind(newLotId, item.item_id, dispatch.to_site_id, conf.received_quantity, conf.received_quantity, dispatchId, `Received via dispatch ${dispatchId}`).run();
      await env.DB.prepare(
        `INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, work_order_id, dispatch_id, notes, created_by)
         VALUES (?, ?, 'transferred_in', ?, ?, ?, ?, ?, ?)`
      ).bind(newLotId, item.item_id, dispatch.to_site_id, conf.received_quantity, dispatch.related_work_order_id, dispatchId, `Confirmed received (${dispatchId})`, actorName || "system").run();

      // A raw-material transfer to a worker for a specific work order becomes
      // a trackable, reconcilable material issue only NOW — at confirmed
      // arrival, not at the moment it left the store.
      if (dispatch.dispatch_type === "stock_transfer" && dispatch.related_work_order_id) {
        const issueId = await nextId(env, "material_issues", "ISS");
        await env.DB.prepare(
          "INSERT INTO material_issues (id, work_order_id, lot_id, quantity_issued, worker_site_id, status) VALUES (?, ?, ?, ?, ?, 'with_worker')"
        ).bind(issueId, dispatch.related_work_order_id, item.lot_id, conf.received_quantity, dispatch.to_site_id).run();
      }
    }
  }

  await env.DB.prepare("UPDATE dispatches SET status = 'received', received_at = datetime('now') WHERE id = ?").bind(dispatchId).run();
  return { ok: true };
}
