export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const partyId = url.searchParams.get("party_id");
  const direction = url.searchParams.get("direction");
  if (!partyId || !direction) return Response.json({ error: "party_id and direction are required" }, { status: 400 });

  async function allocatedByBillId(billType, billIds) {
    const result = {};
    if (!billIds.length) return result;
    const placeholders = billIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT bill_id, COALESCE(SUM(amount_applied),0) AS a FROM payment_allocations WHERE bill_type = ? AND bill_id IN (${placeholders}) GROUP BY bill_id`
    ).bind(billType, ...billIds).all();
    for (const row of results) result[row.bill_id] = row.a;
    return result;
  }

  let bills = [];
  if (direction === "receivable") {
    const { results } = await env.DB.prepare("SELECT * FROM sales WHERE customer_party_id = ? ORDER BY sale_date ASC").bind(partyId).all();
    const saleIds = results.map((s) => s.id);
    const allocatedMap = await allocatedByBillId("sale", saleIds);
    const descByLine = {};
    if (saleIds.length) {
      const placeholders = saleIds.map(() => "?").join(",");
      const { results: allLines } = await env.DB.prepare(`SELECT sale_id, description FROM sale_items WHERE sale_id IN (${placeholders})`).bind(...saleIds).all();
      for (const line of allLines) {
        if (!descByLine[line.sale_id]) descByLine[line.sale_id] = [];
        descByLine[line.sale_id].push(line.description);
      }
    }
    for (const sale of results) {
      const allocated = allocatedMap[sale.id] || 0;
      const outstanding = Math.round((sale.total_amount - allocated) * 100) / 100;
      if (outstanding > 0.001) {
        const summary = (descByLine[sale.id] || []).join(", ") || sale.id;
        bills.push({ bill_type: "sale", bill_id: sale.id, description: summary, total_amount: sale.total_amount, allocated, outstanding, date: sale.sale_date });
      }
    }
  } else if (direction === "payable") {
    const { results } = await env.DB.prepare("SELECT * FROM supplier_bills WHERE supplier_party_id = ? ORDER BY bill_date ASC").bind(partyId).all();
    const allocatedMap = await allocatedByBillId("supplier_bill", results.map((b) => b.id));
    for (const bill of results) {
      const allocated = allocatedMap[bill.id] || 0;
      const outstanding = Math.round((bill.amount - allocated) * 100) / 100;
      if (outstanding > 0.001) bills.push({ bill_type: "supplier_bill", bill_id: bill.id, description: bill.description || bill.bill_number, total_amount: bill.amount, allocated, outstanding, date: bill.bill_date });
    }
  } else if (direction === "worker") {
    const site = await env.DB.prepare("SELECT id FROM sites WHERE worker_party_id = ?").bind(partyId).first();
    if (site) {
      const { results } = await env.DB.prepare("SELECT * FROM work_orders WHERE worker_site_id = ? AND closed_at IS NOT NULL AND labor_cost IS NOT NULL ORDER BY closed_at ASC").bind(site.id).all();
      const allocatedMap = await allocatedByBillId("work_order", results.map((w) => w.id));
      for (const wo of results) {
        const allocated = allocatedMap[wo.id] || 0;
        const outstanding = Math.round((wo.labor_cost - allocated) * 100) / 100;
        if (outstanding > 0.001) bills.push({ bill_type: "work_order", bill_id: wo.id, description: wo.description, total_amount: wo.labor_cost, allocated, outstanding, date: wo.closed_at });
      }
    }
  }

  return Response.json({ bills });
}
