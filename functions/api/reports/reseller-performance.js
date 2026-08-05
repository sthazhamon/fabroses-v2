const PERIOD_DAYS = { monthly: 30, quarterly: 90, last_3_months: 90, last_6_months: 180, yearly: 365 };

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const period = url.searchParams.get("period") || "monthly";
  const days = PERIOD_DAYS[period] || 30;

  const { results: resellers } = await env.DB.prepare("SELECT * FROM parties WHERE type = 'reseller'").all();

  const report = [];
  for (const reseller of resellers) {
    const salesRow = await env.DB.prepare(
      `SELECT COALESCE(SUM(total_amount),0) AS total, COUNT(*) AS count FROM sales
       WHERE customer_party_id = ? AND date(sale_date) >= date('now', ?)`
    ).bind(reseller.id, `-${days} days`).first();

    const targetMet = reseller.target_amount ? salesRow.total >= reseller.target_amount : null;

    report.push({
      party_id: reseller.id, name: reseller.name, discount_tier: reseller.discount_tier,
      sales_total: salesRow.total, sales_count: salesRow.count,
      target_amount: reseller.target_amount, target_period: reseller.target_period,
      target_met: targetMet, bonus_rule: reseller.bonus_rule,
    });
  }

  return Response.json({ period, days, resellers: report.sort((a, b) => b.sales_total - a.sales_total) });
}
