import { postJournalEntry, getOrCreatePartyAccount, accountFixedId, resolveCashBankAccountId, nextId } from "./_ledger.js";
import { createDispatch } from "./_dispatch.js";

async function consumeStock(env, itemId, quantity, forceLotId) {
  if (forceLotId) {
    const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ? AND item_id = ?").bind(forceLotId, itemId).first();
    if (!lot) throw new Error("That lot doesn't exist for this item");
    if (lot.quantity_balance < quantity) throw new Error(`Only ${lot.quantity_balance} left in that specific lot`);
    await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(quantity, lot.id).run();
    return [{ lot_id: lot.id, site_id: lot.site_id, quantity }];
  }
  const { results: lots } = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND quantity_balance > 0 ORDER BY created_at ASC, id ASC").bind(itemId).all();
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

// lines: [{ item_id, lot_id, quantity, description, sale_price, tax_rate }]
export async function createSale(env, { lines, customer_party_id, customer_name, reseller_name, sale_date, notes, created_by, fulfills_customer_order_id, ship_requested, shipping_address, account_id }) {
  if (!lines || !lines.length) throw { status: 400, error: "At least one line item is required" };

  let cashId;
  if (!customer_party_id) cashId = await resolveCashBankAccountId(env, account_id);

  if (fulfills_customer_order_id) {
    const order = await env.DB.prepare("SELECT * FROM customer_orders WHERE id = ?").bind(fulfills_customer_order_id).first();
    if (!order) throw { status: 404, error: "That customer order doesn't exist" };
    if (["billed", "shipped", "cancelled"].includes(order.status)) throw { status: 400, error: `That customer order is already ${order.status}` };
  }

  // Validate every line BEFORE writing anything — avoids leaving a partial
  // sale behind if, say, line 3 of 4 turns out to be short on stock.
  for (const line of lines) {
    // A selected item already names the thing being sold - don't force a
    // separate, manually-typed description on top of it. This was blocking
    // sales entirely whenever someone picked an item (including a
    // sales-return lot) but didn't also retype its name into a second field.
    if (!line.description && line.item_id) {
      const itemRow = await env.DB.prepare("SELECT name FROM items WHERE id = ?").bind(line.item_id).first();
      if (itemRow) line.description = itemRow.name;
    }
    if (!line.description || line.sale_price == null) throw { status: 400, error: "Each line needs a description and sale_price" };
    if (line.item_id) {
      const qty = line.quantity || 1;
      if (line.lot_id) {
        const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ? AND item_id = ?").bind(line.lot_id, line.item_id).first();
        if (!lot) throw { status: 400, error: "That lot doesn't exist for this item" };
        if (lot.quantity_balance < qty) throw { status: 400, error: `Only ${lot.quantity_balance} left in that specific lot` };
      } else {
        const row = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(line.item_id).first();
        if (row.t < qty) throw { status: 400, error: `Only ${row.t} unit(s) in stock for one of these lines` };
      }
    }
  }

  const id = await nextId(env, "sales", "SALE");
  const effectiveDate = sale_date || new Date().toISOString().slice(0, 10);

  // Insert the header first (total filled in once lines are computed) —
  // sale_items has a foreign key to this row, so it must exist first.
  await env.DB.prepare("INSERT INTO sales (id, customer_party_id, customer_name, reseller_name, total_amount, sale_date, notes, shipping_address) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
    .bind(id, customer_party_id || null, customer_name || null, reseller_name || null, effectiveDate, notes || null, ship_requested ? (shipping_address || null) : null).run();

  let grandTotal = 0;
  const lineResults = [];
  const allConsumedForDispatch = []; // {item_id, lot_id, quantity} across every line, for the shipment dispatch below

  for (const line of lines) {
    const qty = line.quantity || 1;
    const rate = line.tax_rate || 0;
    const taxAmount = Math.round(line.sale_price * rate) / 100;
    const lineTotal = line.sale_price + taxAmount;
    grandTotal += lineTotal;

    let consumedLots = [];
    if (line.item_id) consumedLots = await consumeStock(env, line.item_id, qty, line.lot_id || null);

    await env.DB.prepare(
      `INSERT INTO sale_items (sale_id, item_id, lot_id, description, quantity, sale_price, tax_rate, tax_amount, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, line.item_id || null, consumedLots[0]?.lot_id || null, line.description, qty, line.sale_price, rate, taxAmount, lineTotal).run();

    for (const c of consumedLots) {
      await env.DB.prepare("INSERT INTO item_movements (lot_id, item_id, event_type, from_site_id, quantity, notes, created_by) VALUES (?, ?, 'consumed', ?, ?, ?, ?)")
        .bind(c.lot_id, line.item_id, c.site_id, c.quantity, `Sold via ${id}`, created_by || "system").run();
      allConsumedForDispatch.push({ item_id: line.item_id, lot_id: c.lot_id, site_id: c.site_id, quantity: c.quantity });
    }
    lineResults.push({ tax_amount: taxAmount, line_total: lineTotal });
  }

  await env.DB.prepare("UPDATE sales SET total_amount = ? WHERE id = ?").bind(grandTotal, id).run();

  const salesRevenueId = await accountFixedId(env, "3000");
  const jeLines = [];
  if (customer_party_id) jeLines.push({ account_id: await getOrCreatePartyAccount(env, customer_party_id), debit: grandTotal });
  else jeLines.push({ account_id: cashId, debit: grandTotal });

  const totalTax = lineResults.reduce((s, l) => s + l.tax_amount, 0);
  const totalPreTax = grandTotal - totalTax;
  jeLines.push({ account_id: salesRevenueId, credit: totalPreTax });
  if (totalTax) jeLines.push({ account_id: await accountFixedId(env, "2200"), credit: totalTax });

  await postJournalEntry(env, { date: effectiveDate, description: notes || `Sale ${id}`, reference_type: "sale", reference_id: id, created_by, lines: jeLines });

  let shipmentDispatchId = null;
  if (fulfills_customer_order_id) {
    await env.DB.prepare("UPDATE customer_orders SET status = 'billed', sale_id = ?, updated_at = datetime('now') WHERE id = ?").bind(id, fulfills_customer_order_id).run();
  }

  if (allConsumedForDispatch.length) {
    const fromSite = await env.DB.prepare("SELECT site_type FROM sites WHERE id = ?").bind(allConsumedForDispatch[0].site_id).first();
    // A formal customer order always gets its shipment tracked, regardless
    // of which site the stock came from - that's the original, correct
    // behavior. But a direct ("cash sale") purchase previously got no
    // dispatch at all, even when the stock physically came from a worker's
    // own site - silently leaving nothing for the worker to see, and no
    // notification that anything needed to ship. Now it does too, whenever
    // the stock genuinely came from a worker rather than the store.
    const needsDispatch = fulfills_customer_order_id || (fromSite && fromSite.site_type === "worker") || ship_requested;
    if (needsDispatch) {
      shipmentDispatchId = await createDispatch(env, {
        dispatch_type: "customer_shipment", from_site_id: allConsumedForDispatch[0].site_id, to_site_id: null,
        items: allConsumedForDispatch.map((c) => ({ item_id: c.item_id, lot_id: c.lot_id, expected_quantity: c.quantity })),
        related_customer_order_id: fulfills_customer_order_id || null,
        related_sale_id: fulfills_customer_order_id ? null : id,
      });
    }
  }

  return { id, total_amount: grandTotal, lines: lineResults, shipment_dispatch_id: shipmentDispatchId };
}
