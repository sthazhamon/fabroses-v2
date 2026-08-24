export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  // Load every account once, up front, rather than looking each one up
  // individually by code on every call - this is the single biggest source
  // of redundant round-trips in this endpoint.
  const { results: allAccounts } = await env.DB.prepare("SELECT * FROM accounts").all();
  const byCode = {};
  const byId = {};
  for (const acc of allAccounts) { byCode[acc.code] = acc; byId[acc.id] = acc; }

  const expenseParent = allAccounts.find((a) => a.code === "5000");
  const expenseAccounts = expenseParent ? allAccounts.filter((a) => a.parent_account_id === expenseParent.id) : [];

  const relevantCodes = ["3000", "3100", "4000", "4100", ...expenseAccounts.map((a) => a.code)];
  const relevantIds = relevantCodes.map((c) => byCode[c]?.id).filter(Boolean);

  // Sum every relevant account's journal activity in ONE query instead of
  // one query per account.
  const sums = {};
  if (relevantIds.length) {
    const placeholders = relevantIds.map(() => "?").join(",");
    let sumQuery = `SELECT jl.account_id, COALESCE(SUM(jl.debit),0) AS d, COALESCE(SUM(jl.credit),0) AS c
                    FROM journal_lines jl`;
    const params = [...relevantIds];
    if (from && to) {
      sumQuery += ` JOIN journal_entries je ON je.id = jl.journal_entry_id WHERE jl.account_id IN (${placeholders}) AND date(je.entry_date) BETWEEN date(?) AND date(?)`;
      params.push(from, to);
    } else {
      sumQuery += ` WHERE jl.account_id IN (${placeholders})`;
    }
    sumQuery += " GROUP BY jl.account_id";
    const { results: sumRows } = await env.DB.prepare(sumQuery).bind(...params).all();
    for (const row of sumRows) sums[row.account_id] = row;
  }

  function totalFor(code) {
    const account = byCode[code];
    if (!account) return 0;
    const row = sums[account.id] || { d: 0, c: 0 };
    return account.account_type === "revenue" || account.account_type === "liability" ? row.c - row.d : row.d - row.c;
  }

  const salesRevenue = totalFor("3000");
  const salesRefunds = totalFor("3100");
  const rawMaterialConsumed = totalFor("4000");
  const labor = totalFor("4100");

  const revenueAccountIds = ["3000", "3100"].map((c) => byCode[c]?.id).filter(Boolean);
  const cogsAccountIds = ["4000", "4100"].map((c) => byCode[c]?.id).filter(Boolean);

  let totalExpenses = 0;
  const expenseBreakdown = [];
  const expenseAccountIds = [];
  for (const acc of expenseAccounts) {
    const t = totalFor(acc.code);
    totalExpenses += t;
    if (t) expenseBreakdown.push({ name: acc.name, amount: t, account_id: acc.id });
    expenseAccountIds.push(acc.id);
  }

  const netRevenue = salesRevenue - salesRefunds;
  const cogs = rawMaterialConsumed + labor;
  const grossProfit = netRevenue - cogs;
  const netProfit = grossProfit - totalExpenses;

  return Response.json({
    from: from || "all-time", to: to || "all-time",
    sales_revenue: salesRevenue, sales_refunds: salesRefunds, net_revenue: netRevenue, net_revenue_account_ids: revenueAccountIds,
    raw_material_consumed: rawMaterialConsumed, labor, cogs, cogs_account_ids: cogsAccountIds, gross_profit: grossProfit,
    expenses: totalExpenses, expense_breakdown: expenseBreakdown, expense_account_ids: expenseAccountIds, net_profit: netProfit,
  });
}
