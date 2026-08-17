import { postJournalEntry, accountFixedId } from "../../_ledger.js";

export async function onRequestPost({ env, params, data }) {
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(params.id).first();
  if (!dispatch) return Response.json({ error: "Dispatch not found" }, { status: 404 });
  if (dispatch.status !== "shipped") {
    return Response.json({ error: `Can't close this as a loss — it's at "${dispatch.status}", not "shipped". This action is specifically for material that already left but was never confirmed as arrived.` }, { status: 400 });
  }

  const { results: items } = await env.DB.prepare("SELECT di.*, i.name AS item_name FROM dispatch_items di LEFT JOIN items i ON i.id = di.item_id WHERE di.dispatch_id = ?").bind(params.id).all();

  let totalLossValue = 0;
  const lossLines = [];
  for (const item of items) {
    let costPerUnit = 0;
    if (item.lot_id) {
      const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(item.lot_id).first();
      if (lot && lot.cost_total && lot.quantity_original) costPerUnit = lot.cost_total / lot.quantity_original;
    }
    const quantity = item.scanned_quantity != null ? item.scanned_quantity : item.expected_quantity;
    const lineValue = costPerUnit * quantity;
    totalLossValue += lineValue;
    lossLines.push({ item_id: item.item_id, item_name: item.item_name, quantity, value: lineValue });

    await env.DB.prepare(
      "INSERT INTO item_movements (lot_id, item_id, event_type, from_site_id, quantity, dispatch_id, notes, created_by) VALUES (?, ?, 'lost_in_transit', ?, ?, ?, ?, ?)"
    ).bind(item.lot_id || null, item.item_id, dispatch.from_site_id, quantity, params.id, `Closed as loss — shipped but never confirmed received (${params.id})`, data.user?.name || "admin").run();
  }

  await env.DB.prepare("UPDATE dispatches SET status = 'lost' WHERE id = ?").bind(params.id).run();

  if (totalLossValue > 0.001) {
    const lossAccountId = await accountFixedId(env, "4200");
    const inventoryAccountId = await accountFixedId(env, "1200");
    await postJournalEntry(env, {
      date: new Date().toISOString().slice(0, 10), description: `Inventory loss — ${params.id} shipped but never confirmed`,
      reference_type: "dispatch", reference_id: params.id, created_by: data.user?.name,
      lines: [{ account_id: lossAccountId, debit: totalLossValue }, { account_id: inventoryAccountId, credit: totalLossValue }],
    });
  }

  return Response.json({ ok: true, total_loss_value: totalLossValue, lines: lossLines });
}
