async function accountTotal(env, code, from, to) {
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE code = ?").bind(code).first();
  if (!account) return 0;
  let q = "SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines WHERE account_id = ?";
  const params = [account.id];
  if (from && to) {
    q = `SELECT COALESCE(SUM(jl.debit),0) AS d, COALESCE(SUM(jl.credit),0) AS c FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id WHERE jl.account_id = ? AND date(je.entry_date) BETWEEN date(?) AND date(?)`;
    params.push(from, to);
  }
  const row = await env.DB.prepare(q).bind(...params).first();
  // Revenue/liability accounts grow on credit; asset/expense/cogs accounts grow on debit.
  return account.account_type === "revenue" || account.account_type === "liability" ? row.c - row.d : row.d - row.c;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const salesRevenue = await accountTotal(env, "3000", from, to);
  const salesRefunds = await accountTotal(env, "3100", from, to);
  const rawMaterialConsumed = await accountTotal(env, "4000", from, to);
  const labor = await accountTotal(env, "4100", from, to);

  const { results: expenseAccounts } = await env.DB.prepare("SELECT id, code, name FROM accounts WHERE parent_account_id = (SELECT id FROM accounts WHERE code='5000')").all();
  let totalExpenses = 0;
  const expenseBreakdown = [];
  for (const acc of expenseAccounts) {
    const t = await accountTotal(env, acc.code, from, to);
    totalExpenses += t;
    if (t) expenseBreakdown.push({ name: acc.name, amount: t });
  }

  const netRevenue = salesRevenue - salesRefunds;
  const cogs = rawMaterialConsumed + labor;
  const grossProfit = netRevenue - cogs;
  const netProfit = grossProfit - totalExpenses;

  return Response.json({
    from: from || "all-time", to: to || "all-time",
    sales_revenue: salesRevenue, sales_refunds: salesRefunds, net_revenue: netRevenue,
    raw_material_consumed: rawMaterialConsumed, labor, cogs, gross_profit: grossProfit,
    expenses: totalExpenses, expense_breakdown: expenseBreakdown, net_profit: netProfit,
  });
}
