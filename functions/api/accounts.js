export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const cashBankOnly = url.searchParams.get("cash_bank");
  let q = `SELECT a.*, p.name AS parent_name, pty.name AS party_name FROM accounts a
     LEFT JOIN accounts p ON p.id = a.parent_account_id
     LEFT JOIN parties pty ON pty.id = a.party_id`;
  if (cashBankOnly) q += " WHERE a.is_cash_or_bank = 1";
  q += " ORDER BY a.code ASC, a.name ASC";
  const { results } = await env.DB.prepare(q).all();
  return Response.json(results);
}

// Lets an admin add another cash/bank account head — "Bank A", "Cash B",
// and so on — alongside the two built-in ones. Deliberately narrow: this
// only ever creates a cash/bank-flagged asset account, not an arbitrary
// ledger account, so it can't be used to quietly reshape the chart of
// accounts (AR, inventory, revenue, etc. still aren't editable here).
export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const name = (body.name || "").trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const clash = await env.DB.prepare("SELECT id FROM accounts WHERE name = ? COLLATE NOCASE").bind(name).first();
  if (clash) return Response.json({ error: `An account named "${name}" already exists` }, { status: 400 });

  const res = await env.DB.prepare("INSERT INTO accounts (name, account_type, is_cash_or_bank) VALUES (?, 'asset', 1)").bind(name).run();
  return Response.json({ id: res.meta.last_row_id, name, account_type: "asset", is_cash_or_bank: 1 });
}
