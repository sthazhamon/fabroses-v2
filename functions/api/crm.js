export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const { results: parties } = await env.DB.prepare("SELECT * FROM parties WHERE type IN ('customer', 'reseller')").all();
  if (!parties.length) return Response.json([]);

  // Fetch every relevant sale, for every party, in one query - rather than
  // one query per party.
  const partyIds = parties.map((p) => p.id);
  const placeholders = partyIds.map(() => "?").join(",");
  let saleQuery = `SELECT * FROM sales WHERE customer_party_id IN (${placeholders})`;
  const saleParams = [...partyIds];
  if (from && to) { saleQuery += " AND date(sale_date) BETWEEN date(?) AND date(?)"; saleParams.push(from, to); }
  const { results: allSales } = await env.DB.prepare(saleQuery).bind(...saleParams).all();

  const salesByParty = {};
  for (const sale of allSales) {
    if (!salesByParty[sale.customer_party_id]) salesByParty[sale.customer_party_id] = [];
    salesByParty[sale.customer_party_id].push(sale);
  }

  // Fetch every line for every one of those sales in one query.
  const lineItemsBySale = {};
  const lotIdsNeeded = new Set();
  if (allSales.length) {
    const saleIds = allSales.map((s) => s.id);
    const salePlaceholders = saleIds.map(() => "?").join(",");
    const { results: allLines } = await env.DB.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${salePlaceholders})`).bind(...saleIds).all();
    for (const line of allLines) {
      if (!lineItemsBySale[line.sale_id]) lineItemsBySale[line.sale_id] = [];
      lineItemsBySale[line.sale_id].push(line);
      if (line.lot_id) lotIdsNeeded.add(line.lot_id);
    }
  }

  // Fetch every lot referenced by any of those lines in one query.
  const lotCosts = {};
  if (lotIdsNeeded.size) {
    const lotIds = [...lotIdsNeeded];
    const lotPlaceholders = lotIds.map(() => "?").join(",");
    const { results: lots } = await env.DB.prepare(`SELECT id, cost_total, quantity_original FROM item_lots WHERE id IN (${lotPlaceholders})`).bind(...lotIds).all();
    for (const lot of lots) lotCosts[lot.id] = lot;
  }

  const crm = [];
  for (const party of parties) {
    const sales = salesByParty[party.id] || [];
    if (!sales.length) continue;

    let totalOrderValue = 0;
    let totalCogs = 0;
    for (const sale of sales) {
      totalOrderValue += sale.total_amount;
      const lines = lineItemsBySale[sale.id] || [];
      for (const line of lines) {
        if (!line.lot_id) continue;
        const lot = lotCosts[line.lot_id];
        if (lot && lot.cost_total && lot.quantity_original) {
          const costPerUnit = lot.cost_total / lot.quantity_original;
          totalCogs += costPerUnit * line.quantity;
        }
      }
    }

    const approxProfit = totalOrderValue - totalCogs;
    crm.push({
      party_id: party.id, party_name: party.name, party_type: party.type,
      order_count: sales.length, total_order_value: Math.round(totalOrderValue * 100) / 100,
      approx_cogs: Math.round(totalCogs * 100) / 100, approx_profit_margin: Math.round(approxProfit * 100) / 100,
    });
  }

  crm.sort(function (a, b) { return b.total_order_value - a.total_order_value; });

  return Response.json(crm);
}
