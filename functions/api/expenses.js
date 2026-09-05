import { postJournalEntry, getOrCreateExpenseCategoryAccount, resolveCashBankAccountId, nextId } from "./_ledger.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, c.name AS category_name FROM expenses e LEFT JOIN expense_categories c ON c.id = e.expense_category_id ORDER BY e.date DESC, e.id DESC`
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const { date, description, expense_category_id, paid_by, amount, account_id } = body;
  if (!amount || !description) return Response.json({ error: "description and amount are required" }, { status: 400 });
  if (!expense_category_id) return Response.json({ error: "expense_category_id is required" }, { status: 400 });

  let cashId;
  try { cashId = await resolveCashBankAccountId(env, account_id); }
  catch (e) { return Response.json({ error: e.message }, { status: 400 }); }

  const id = await nextId(env, "expenses", "EXP");
  const effectiveDate = date || new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO expenses (id, date, description, expense_category_id, paid_by, amount, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, effectiveDate, description, expense_category_id, paid_by || null, amount, cashId).run();

  const expenseAccountId = await getOrCreateExpenseCategoryAccount(env, expense_category_id);
  await postJournalEntry(env, {
    date: effectiveDate, description, reference_type: "expense", reference_id: id, created_by: data.user?.name,
    lines: [{ account_id: expenseAccountId, debit: amount }, { account_id: cashId, credit: amount }],
  });

  return Response.json({ id });
}
