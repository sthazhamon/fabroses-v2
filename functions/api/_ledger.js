async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

// lines: [{account_id, debit, credit}, ...] — must balance or this throws.
export async function postJournalEntry(env, { date, description, reference_type, reference_id, created_by, lines }) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.round(totalDebit * 100) !== Math.round(totalCredit * 100)) {
    throw new Error(`Journal entry doesn't balance: debit ${totalDebit.toFixed(2)} vs credit ${totalCredit.toFixed(2)}`);
  }
  const id = await nextId(env, "journal_entries", "JE");
  await env.DB.prepare(
    "INSERT INTO journal_entries (id, entry_date, description, reference_type, reference_id, created_by) VALUES (?,?,?,?,?,?)"
  ).bind(id, date, description || null, reference_type || null, reference_id || null, created_by || null).run();
  for (const line of lines) {
    if (!line.debit && !line.credit) continue;
    await env.DB.prepare("INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES (?,?,?,?)")
      .bind(id, line.account_id, line.debit || 0, line.credit || 0).run();
  }
  return id;
}

const PARENT_CODE_FOR_TYPE = { customer: "1100", reseller: "1100", supplier: "2000", worker: "2050" };
const ACCOUNT_TYPE_FOR_PARENT = { "1100": "asset", "2000": "liability", "2050": "liability" };

// Every party gets exactly one sub-account, created on first use, filed
// under the right parent (AR for customers/resellers, AP for suppliers,
// Wages Payable for workers).
export async function getOrCreatePartyAccount(env, partyId) {
  const party = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(partyId).first();
  if (!party) throw new Error("Party not found");
  if (party.account_id) return party.account_id;

  const parentCode = PARENT_CODE_FOR_TYPE[party.type] || "1100";
  const parent = await env.DB.prepare("SELECT id FROM accounts WHERE code = ?").bind(parentCode).first();
  const res = await env.DB.prepare(
    "INSERT INTO accounts (name, account_type, parent_account_id, party_id) VALUES (?,?,?,?)"
  ).bind(party.name, ACCOUNT_TYPE_FOR_PARENT[parentCode], parent.id, party.id).run();
  const accountId = res.meta.last_row_id;
  await env.DB.prepare("UPDATE parties SET account_id = ? WHERE id = ?").bind(accountId, party.id).run();
  return accountId;
}

export async function getOrCreateExpenseCategoryAccount(env, expenseCategoryId) {
  const cat = await env.DB.prepare("SELECT * FROM expense_categories WHERE id = ?").bind(expenseCategoryId).first();
  if (!cat) throw new Error("Expense category not found");
  if (cat.account_id) return cat.account_id;
  const parent = await env.DB.prepare("SELECT id FROM accounts WHERE code = '5000'").first();
  const res = await env.DB.prepare("INSERT INTO accounts (name, account_type, parent_account_id) VALUES (?, 'expense', ?)")
    .bind(cat.name, parent.id).run();
  const accountId = res.meta.last_row_id;
  await env.DB.prepare("UPDATE expense_categories SET account_id = ? WHERE id = ?").bind(accountId, cat.id).run();
  return accountId;
}

export async function accountFixedId(env, code) {
  const row = await env.DB.prepare("SELECT id FROM accounts WHERE code = ?").bind(code).first();
  if (!row) throw new Error(`Account ${code} not found — schema may not be loaded correctly`);
  return row.id;
}

// Resolves which cash/bank account a real money movement actually went
// through. Every flow that used to hardcode the built-in Cash account
// (expenses, refunds, supplier bill instant-payment, walk-in cash sales)
// now optionally accepts an account_id and calls this instead — same
// validation everywhere, and still defaults to Cash when nothing was
// chosen, so nothing that doesn't pass one changes behavior.
export async function resolveCashBankAccountId(env, accountId) {
  if (!accountId) return accountFixedId(env, "1000");
  const row = await env.DB.prepare("SELECT id FROM accounts WHERE id = ? AND is_cash_or_bank = 1").bind(accountId).first();
  if (!row) throw new Error("account_id must be a cash or bank account");
  return row.id;
}

export async function createWorkerSite(env, { name, worker_user_id }) {
  const id = await nextId(env, "sites", "SITE");
  const partyId = await nextId(env, "parties", "PTY");
  try {
    await env.DB.prepare("INSERT INTO parties (id, name, type) VALUES (?, ?, 'worker')").bind(partyId, name).run();
  } catch (e) {
    await env.DB.prepare("INSERT INTO parties (id, name, type) VALUES (?, ?, 'worker')").bind(partyId, name + " (" + id + ")").run();
  }
  await env.DB.prepare(
    "INSERT INTO sites (id, name, site_type, worker_user_id, worker_party_id) VALUES (?, ?, 'worker', ?, ?)"
  ).bind(id, name, worker_user_id || null, partyId).run();
  if (worker_user_id) await env.DB.prepare("UPDATE users SET site_id = ? WHERE id = ?").bind(id, worker_user_id).run();
  return { siteId: id, partyId };
}

export { nextId, PARENT_CODE_FOR_TYPE, ACCOUNT_TYPE_FOR_PARENT };
