import { postJournalEntry, getOrCreatePartyAccount, accountFixedId } from "../../_ledger.js";

async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json().catch(() => ({}));
  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Work order not found" }, { status: 404 });
  if (order.job_type !== "production") return Response.json({ error: "Mark Job Done applies to production jobs — rework has its own flow" }, { status: 400 });
  if (order.stage !== "Work Started") return Response.json({ error: `This job is at "${order.stage}" — it needs to be Work Started before it can be marked done` }, { status: 400 });
  if (order.cancelled_at) return Response.json({ error: "This job is cancelled" }, { status: 400 });

  const quantityDone = body.quantity_done || order.target_quantity;
  const laborCost = body.labor_cost != null && body.labor_cost !== "" ? parseFloat(body.labor_cost) : null;

  const { results: bomLines } = await env.DB.prepare("SELECT * FROM item_bom WHERE finished_item_id = ?").bind(order.intended_item_id).all();
  const { results: openIssues } = await env.DB.prepare(
    `SELECT mi.*, l.item_id AS raw_item_id FROM material_issues mi LEFT JOIN item_lots l ON l.id = mi.lot_id
     WHERE mi.work_order_id = ? AND mi.status != 'received' ORDER BY mi.issued_at ASC, mi.id ASC`
  ).bind(params.id).all();

  // Upfront validation, before touching anything: every BOM line needs
  // enough reserved material across this job's open issues.
  for (const bomLine of bomLines) {
    const expected = bomLine.quantity_required * quantityDone;
    const reserved = openIssues.filter((i) => i.raw_item_id === bomLine.raw_material_item_id).reduce((s, i) => s + (i.quantity_issued - i.quantity_returned_stock - i.quantity_wasted), 0);
    if (reserved < expected - 0.001) {
      return Response.json({ error: `Not enough raw material reserved for this job — needs ${expected}, only ${reserved} reserved. Check whether a dispatch is still in transit, or issue more material first.` }, { status: 400 });
    }
  }

  // Consume exactly the BOM-expected amount — not the full issued amount.
  // Allocate across this job's open issues for each raw material, oldest
  // first, decrementing the worker's real stock via FIFO for only what's
  // genuinely used. Anything issued beyond what's needed stays untouched
  // as real leftover stock — it never physically moved, so nothing needs
  // to be "returned"; it's simply still sitting there.
  const consumptionLog = [];
  let rawMaterialCost = 0;
  for (const bomLine of bomLines) {
    let remainingToConsume = bomLine.quantity_required * quantityDone;
    const matchingIssues = openIssues.filter((i) => i.raw_item_id === bomLine.raw_material_item_id);

    for (const issue of matchingIssues) {
      const issueOutstanding = issue.quantity_issued - issue.quantity_returned_stock - issue.quantity_wasted;
      const consumeFromThisIssue = Math.min(remainingToConsume, issueOutstanding);
      const leftoverOnThisIssue = issueOutstanding - consumeFromThisIssue;

      if (consumeFromThisIssue > 0.0001) {
        const { results: workerLots } = await env.DB.prepare(
          "SELECT * FROM item_lots WHERE item_id = ? AND site_id = ? AND quantity_balance > 0 ORDER BY created_at ASC, id ASC"
        ).bind(bomLine.raw_material_item_id, order.worker_site_id).all();
        const totalAtWorker = workerLots.reduce((s, l) => s + l.quantity_balance, 0);
        if (totalAtWorker < consumeFromThisIssue - 0.001) {
          return Response.json({ error: `Only ${totalAtWorker} physically at the worker's site for one of the raw materials — can't consume ${consumeFromThisIssue}. There may be a data inconsistency worth checking.` }, { status: 400 });
        }
        let remaining = consumeFromThisIssue;
        for (const lot of workerLots) {
          if (remaining <= 0) break;
          const take = Math.min(lot.quantity_balance, remaining);
          await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(take, lot.id).run();
          const costPerUnit = lot.cost_total && lot.quantity_original ? lot.cost_total / lot.quantity_original : 0;
          rawMaterialCost += costPerUnit * take;
          await env.DB.prepare("INSERT INTO item_movements (lot_id, item_id, event_type, from_site_id, quantity, work_order_id, notes, created_by) VALUES (?, ?, 'consumed', ?, ?, ?, ?, ?)")
            .bind(lot.id, bomLine.raw_material_item_id, order.worker_site_id, take, params.id, `Consumed per BOM on Mark Job Done (${params.id})`, data.user?.name || "system").run();
          remaining -= take;
        }
      }

      // Close out the issue: record what was consumed vs left over.
      // The leftover never physically moved, so no new lot is created for
      // it — it's simply still sitting in the worker's own remaining stock.
      await env.DB.prepare(
        "UPDATE material_issues SET quantity_returned_stock = quantity_returned_stock + ?, status = 'received', received_at = datetime('now') WHERE id = ?"
      ).bind(leftoverOnThisIssue, issue.id).run();

      consumptionLog.push({ material_issue_id: issue.id, consumed: consumeFromThisIssue, left_as_stock: leftoverOnThisIssue });
      remainingToConsume -= consumeFromThisIssue;
    }
  }

  // Real COGS entry for the raw material actually consumed — this is the
  // one moment production jobs recognize this cost in the ledger.
  if (rawMaterialCost > 0.001) {
    const rawMaterialCogsId = await accountFixedId(env, "4000");
    const rawMaterialInventoryId = await accountFixedId(env, "1200");
    await postJournalEntry(env, {
      date: new Date().toISOString().slice(0, 10), description: `Raw material consumed — ${params.id}`,
      reference_type: "work_order", reference_id: params.id, created_by: data.user?.name,
      lines: [{ account_id: rawMaterialCogsId, debit: rawMaterialCost }, { account_id: rawMaterialInventoryId, credit: rawMaterialCost }],
    });
  }

  // Labor cost, if entered here — mirrors exactly how a Supplier Bill
  // works: debit the expense, credit the worker's own party account,
  // creating a liability that a later Worker Payment simply settles.
  if (laborCost != null && laborCost > 0) {
    const workerSite = await env.DB.prepare("SELECT worker_party_id FROM sites WHERE id = ?").bind(order.worker_site_id).first();
    if (workerSite && workerSite.worker_party_id) {
      const laborCogsId = await accountFixedId(env, "4100");
      const workerAccountId = await getOrCreatePartyAccount(env, workerSite.worker_party_id);
      await postJournalEntry(env, {
        date: new Date().toISOString().slice(0, 10), description: `Labor cost — ${params.id}`,
        reference_type: "work_order", reference_id: params.id, created_by: data.user?.name,
        lines: [{ account_id: laborCogsId, debit: laborCost }, { account_id: workerAccountId, credit: laborCost }],
      });
    }
  }

  // Create the finished-good lot right at the worker's own site — plain
  // stock from here on, shipped back later via the normal stock-transfer
  // mechanism, not a special ship-back flow.
  const finishedLotId = await nextId(env, "item_lots", "LOT");
  await env.DB.prepare(
    `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, cost_total, notes)
     VALUES (?, ?, ?, ?, ?, 'work_order_output', ?, ?, ?)`
  ).bind(finishedLotId, order.intended_item_id, order.worker_site_id, quantityDone, quantityDone, params.id, rawMaterialCost + (laborCost || 0), `Completed via Mark Job Done (${params.id})`).run();
  await env.DB.prepare("INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, work_order_id, notes, created_by) VALUES (?, ?, 'produced', ?, ?, ?, ?, ?)")
    .bind(finishedLotId, order.intended_item_id, order.worker_site_id, quantityDone, params.id, `Job marked done (${params.id})`, data.user?.name || "system").run();

  await env.DB.prepare("UPDATE work_orders SET stage = 'Work Done', output_item_id = ?, labor_cost = COALESCE(labor_cost, 0) + ?, updated_at = datetime('now') WHERE id = ?")
    .bind(order.intended_item_id, laborCost || 0, params.id).run();
  await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, 'Work Done', ?)").bind(params.id, data.user?.name || "unknown").run();

  return Response.json({ ok: true, finished_lot_id: finishedLotId, quantity_done: quantityDone, raw_material_cost: rawMaterialCost, labor_cost: laborCost, raw_material_consumed: consumptionLog });
}
