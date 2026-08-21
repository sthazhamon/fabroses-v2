export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const accountId = url.searchParams.get("account_id");
  const accountIdsParam = url.searchParams.get("account_ids");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (!accountId && !accountIdsParam) return Response.json({ error: "account_id or account_ids is required" }, { status: 400 });
  const ids = accountIdsParam ? accountIdsParam.split(",").map((s) => s.trim()).filter(Boolean) : [accountId];

  const placeholders = ids.map(() => "?").join(",");
  let q = `SELECT jl.*, je.entry_date, je.description, je.reference_type, je.reference_id
           FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
           WHERE jl.account_id IN (${placeholders})`;
  const params = [...ids];
  if (from && to) { q += " AND date(je.entry_date) BETWEEN date(?) AND date(?)"; params.push(from, to); }
  q += " ORDER BY je.entry_date ASC, je.id ASC";

  const { results } = await env.DB.prepare(q).bind(...params).all();
  const totalDebit = results.reduce((s, r) => s + r.debit, 0);
  const totalCredit = results.reduce((s, r) => s + r.credit, 0);

  return Response.json({ entries: results, total_debit: Math.round(totalDebit * 100) / 100, total_credit: Math.round(totalCredit * 100) / 100 });
}
