import { postJournalEntry } from "./_ledger.js";

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const { date, description, debit_account_id, credit_account_id, amount } = body;
  if (!debit_account_id || !credit_account_id || !amount) {
    return Response.json({ error: "debit_account_id, credit_account_id, and amount are required" }, { status: 400 });
  }
  if (debit_account_id === credit_account_id) {
    return Response.json({ error: "Debit and credit accounts must be different" }, { status: 400 });
  }

  try {
    const id = await postJournalEntry(env, {
      date: date || new Date().toISOString().slice(0, 10), description: description || "Manual journal entry",
      reference_type: "manual", created_by: data.user?.name,
      lines: [{ account_id: debit_account_id, debit: amount }, { account_id: credit_account_id, credit: amount }],
    });
    return Response.json({ id });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
