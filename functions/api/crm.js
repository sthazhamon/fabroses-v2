export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const { results: parties } = await env.DB.prepare("SELECT * FROM parties WHERE type IN ('customer', 'reseller')").all();

  const crm = [];
  for (const party of parties) {
    let saleQuery = "SELECT * FROM sales WHERE customer_party_id = ?";
    const params = [party.id];
    if (from && to) { saleQuery += " AND date(sale_date) BETWEEN date(?) AND date(?)"; params.push(from, to); }
    const { results: sales } = await env.DB.prepare(saleQuery).bind(...params).all();

    if (!sales.length) continue;

    let totalOrderValue = 0;
    let totalCogs = 0;
    for (const sale of sales) {
      totalOrderValue += sale.total_amount;
      const { results: lines } = await env.DB.prepare("SELECT * FROM sale_items WHERE sale_id = ?").bind(sale.id).all();
      for (const line of lines) {
        if (!line.lot_id) continue;
        const lot = await env.DB.prepare("SELECT cost_total, quantity_original FROM item_lots WHERE id = ?").bind(line.lot_id).first();
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
