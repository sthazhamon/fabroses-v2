import { postJournalEntry, getOrCreatePartyAccount, accountFixedId, nextId } from "./_ledger.js";

async function computeBalance(env, party) {
  if (!party.account_id) return { balance: party.opening_balance, billed: 0, settled: 0 };
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines WHERE account_id = ?"
  ).bind(party.account_id).first();
  const account = await env.DB.prepare("SELECT account_type FROM accounts WHERE id = ?").bind(party.account_id).first();
  const net = account.account_type === "asset" ? row.d - row.c : row.c - row.d;
  return { balance: Math.round(net * 100) / 100, billed: row.d, settled: row.c };
}

async function openingEquityAccountId(env) {
  const existing = await env.DB.prepare("SELECT id FROM accounts WHERE code = '3900'").first();
  if (existing) return existing.id;
  const res = await env.DB.prepare("INSERT INTO accounts (code, name, account_type) VALUES ('3900', 'Opening Balance Equity', 'revenue')").run();
  return res.meta.last_row_id;
}

export async function onRequestGet({ env }) {
  const { results: parties } = await env.DB.prepare("SELECT * FROM parties ORDER BY name ASC").all();
  const withBalances = [];
  for (const party of parties) withBalances.push({ ...party, ...(await computeBalance(env, party)) });
  return Response.json(withBalances);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const name = (body.name || "").trim();
  const type = body.type;
  const validTypes = ["customer", "reseller", "supplier", "worker", "other"];
  if (!name || !validTypes.includes(type)) return Response.json({ error: `name and a valid type (${validTypes.join(", ")}) are required` }, { status: 400 });
  if (body.discount_tier && ![1, 2, 3].includes(body.discount_tier)) {
    return Response.json({ error: "discount_tier must be 1, 2, or 3" }, { status: 400 });
  }

  const id = await nextId(env, "parties", "PTY");
  try {
    await env.DB.prepare(
      `INSERT INTO parties (id, name, type, phone, notes, opening_balance, discount_tier, target_amount, target_period, bonus_rule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, name, type, body.phone || null, body.notes || null, body.opening_balance || 0,
      body.discount_tier || null, body.target_amount || null, body.target_period || null, body.bonus_rule || null
    ).run();
  } catch (e) {
    return Response.json({ error: "A party with that name already exists" }, { status: 400 });
  }

  if (body.opening_balance) {
    const accountId = await getOrCreatePartyAccount(env, id);
    const openingId = await openingEquityAccountId(env);
    const isReceivableSide = type === "customer" || type === "reseller";
    await postJournalEntry(env, {
      date: new Date().toISOString().slice(0, 10), description: `Opening balance for ${name}`, reference_type: "opening_balance", reference_id: id,
      lines: isReceivableSide
        ? [{ account_id: accountId, debit: body.opening_balance }, { account_id: openingId, credit: body.opening_balance }]
        : [{ account_id: openingId, debit: body.opening_balance }, { account_id: accountId, credit: body.opening_balance }],
    });
  }

  return Response.json({ id });
}
