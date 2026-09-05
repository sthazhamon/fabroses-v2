import { postJournalEntry, getOrCreatePartyAccount, resolveCashBankAccountId, accountFixedId, nextId } from "./_ledger.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare("SELECT * FROM refunds ORDER BY refund_date DESC, id DESC").all();
  return Response.json(results);
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const { sale_id, amount, reason, refund_date, account_id } = body;
  if (!sale_id || !amount) return Response.json({ error: "sale_id and amount are required" }, { status: 400 });

  const sale = await env.DB.prepare("SELECT * FROM sales WHERE id = ?").bind(sale_id).first();
  if (!sale) return Response.json({ error: "Sale not found" }, { status: 404 });

  const alreadyRefunded = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM refunds WHERE sale_id = ?").bind(sale_id).first();
  const remaining = sale.total_amount - alreadyRefunded.t;
  if (amount > remaining + 0.001) {
    return Response.json({ error: `Only ${remaining.toFixed(2)} is still refundable on this sale` }, { status: 400 });
  }

  let cashId;
  if (!sale.customer_party_id) {
    try { cashId = await resolveCashBankAccountId(env, account_id); }
    catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
  }

  const id = await nextId(env, "refunds", "REF");
  const effectiveDate = refund_date || new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO refunds (id, sale_id, customer_party_id, amount, reason, refund_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, sale_id, sale.customer_party_id || null, amount, reason || null, effectiveDate, data.user?.name || "unknown").run();

  const refundsAccountId = await accountFixedId(env, "3100");
  const lines = [{ account_id: refundsAccountId, debit: amount }];
  if (sale.customer_party_id) lines.push({ account_id: await getOrCreatePartyAccount(env, sale.customer_party_id), credit: amount });
  else lines.push({ account_id: cashId, credit: amount });

  await postJournalEntry(env, { date: effectiveDate, description: reason || `Refund on ${sale_id}`, reference_type: "refund", reference_id: id, created_by: data.user?.name, lines });

  return Response.json({ id });
}
