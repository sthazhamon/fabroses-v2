import { postJournalEntry, getOrCreatePartyAccount, accountFixedId, nextId } from "./_ledger.js";

// Consumes stock either from a SPECIFIC lot (when the person scanned the
// exact physical piece) or FIFO across whatever lots exist (default).
// Returns the list of {lot_id, quantity} actually consumed, for movement logging.
async function consumeStock(env, itemId, quantity, forceLotId) {
  if (forceLotId) {
    const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ? AND item_id = ?").bind(forceLotId, itemId).first();
    if (!lot) throw new Error("That lot doesn't exist for this item");
    if (lot.quantity_balance < quantity) throw new Error(`Only ${lot.quantity_balance} left in that specific lot`);
    await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(quantity, lot.id).run();
    return [{ lot_id: lot.id, site_id: lot.site_id, quantity }];
  }
  const { results: lots } = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND quantity_balance > 0 ORDER BY created_at ASC").bind(itemId).all();
  const available = lots.reduce((s, l) => s + l.quantity_balance, 0);
  if (available < quantity) throw new Error(`Only ${available} unit(s) in stock`);
  let remaining = quantity;
  const consumed = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.quantity_balance, remaining);
    await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(take, lot.id).run();
    consumed.push({ lot_id: lot.id, site_id: lot.site_id, quantity: take });
    remaining -= take;
  }
  return consumed;
}

export async function createSale(env, { item_id, lot_id, quantity, description, customer_party_id, customer_name, reseller_name, sale_price, tax_rate, sale_date, created_by }) {
  if (!description || !sale_price) throw { status: 400, error: "description and sale_price are required" };
  const qty = quantity || 1;
  const rate = tax_rate || 0;
  const taxAmount = Math.round(sale_price * rate) / 100;
  const totalAmount = sale_price + taxAmount;

  let consumedLots = [];
  if (item_id) {
    consumedLots = await consumeStock(env, item_id, qty, lot_id || null);
  }

  const id = await nextId(env, "sales", "SALE");
  const effectiveDate = sale_date || new Date().toISOString().slice(0, 10);

  await env.DB.prepare(
    `INSERT INTO sales (id, item_id, lot_id, quantity, description, customer_party_id, customer_name, reseller_name, sale_price, tax_rate, tax_amount, total_amount, sale_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, item_id || null, consumedLots[0]?.lot_id || null, qty, description, customer_party_id || null,
    customer_name || null, reseller_name || null, sale_price, rate, taxAmount, totalAmount, effectiveDate
  ).run();

  for (const c of consumedLots) {
    await env.DB.prepare(
      "INSERT INTO item_movements (lot_id, item_id, event_type, from_site_id, quantity, notes, created_by) VALUES (?, ?, 'consumed', ?, ?, ?, ?)"
    ).bind(c.lot_id, item_id, c.site_id, c.quantity, `Sold via ${id}`, created_by || "system").run();
  }

  // Double-entry: debit AR (or Cash if no party given), credit Sales
  // Revenue, credit Tax Payable if applicable.
  const salesRevenueId = await accountFixedId(env, "3000");
  const lines = [];
  if (customer_party_id) {
    lines.push({ account_id: await getOrCreatePartyAccount(env, customer_party_id), debit: totalAmount });
  } else {
    lines.push({ account_id: await accountFixedId(env, "1000"), debit: totalAmount });
  }
  lines.push({ account_id: salesRevenueId, credit: sale_price });
  if (taxAmount) lines.push({ account_id: await accountFixedId(env, "2200"), credit: taxAmount });

  await postJournalEntry(env, { date: effectiveDate, description, reference_type: "sale", reference_id: id, created_by, lines });

  return { id, tax_amount: taxAmount, total_amount: totalAmount };
}
