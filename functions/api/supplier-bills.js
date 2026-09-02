import { postJournalEntry, getOrCreatePartyAccount, accountFixedId, nextId } from "./_ledger.js";

export async function onRequestGet({ env }) {
  const { results: bills } = await env.DB.prepare("SELECT * FROM supplier_bills ORDER BY bill_date DESC, id DESC").all();
  if (!bills.length) return Response.json([]);

  const billIds = bills.map((b) => b.id);
  const placeholders = billIds.map(() => "?").join(",");
  const { results: allLines } = await env.DB.prepare(
    `SELECT sbi.*, i.name AS item_name FROM supplier_bill_items sbi LEFT JOIN items i ON i.id = sbi.item_id WHERE sbi.supplier_bill_id IN (${placeholders})`
  ).bind(...billIds).all();

  const linesByBill = {};
  for (const line of allLines) {
    if (!linesByBill[line.supplier_bill_id]) linesByBill[line.supplier_bill_id] = [];
    linesByBill[line.supplier_bill_id].push(line);
  }

  return Response.json(bills.map((bill) => ({ ...bill, lines: linesByBill[bill.id] || [] })));
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const { purchase_order_id, supplier_party_id, supplier_name, bill_number, bill_date, description, lines } = body;
  if (!supplier_name || !lines || !lines.length) return Response.json({ error: "supplier_name and at least one line item are required" }, { status: 400 });

  let preTaxAmount = 0, totalTax = 0;
  for (const line of lines) {
    if (!line.quantity || line.rate == null) return Response.json({ error: "Each line needs quantity and rate" }, { status: 400 });
    const lineBase = line.quantity * line.rate;
    const lineTax = Math.round(lineBase * (line.tax_rate || 0)) / 100;
    preTaxAmount += lineBase;
    totalTax += lineTax;
  }
  const amount = preTaxAmount + totalTax;

  const id = await nextId(env, "supplier_bills", "SBILL");
  const effectiveDate = bill_date || new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO supplier_bills (id, purchase_order_id, supplier_party_id, supplier_name, bill_number, bill_date, amount, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, purchase_order_id || null, supplier_party_id || null, supplier_name, bill_number || null, effectiveDate, amount, description || null).run();

  for (const line of lines) {
    const lineBase = line.quantity * line.rate;
    const lineTax = Math.round(lineBase * (line.tax_rate || 0)) / 100;
    await env.DB.prepare(
      "INSERT INTO supplier_bill_items (supplier_bill_id, purchase_order_item_id, item_id, quantity, rate, tax_rate, tax_amount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, line.purchase_order_item_id || null, line.item_id || null, line.quantity, line.rate, line.tax_rate || 0, lineTax, lineBase + lineTax).run();

    // The lot(s) this receipt created may have already gotten a PO-rate
    // estimate at receive time. Now that the actual bill has arrived
    // (possibly at a different rate, after tax/negotiation), refresh their
    // cost basis - but only lots still sitting in stock, since anything
    // already consumed by a completed job already had its own cost locked
    // in at that moment and isn't retroactively changed by this.
    if (purchase_order_id && line.item_id) {
      const { results: lotsToUpdate } = await env.DB.prepare(
        "SELECT id, quantity_original FROM item_lots WHERE source_reference = ? AND item_id = ? AND quantity_balance > 0"
      ).bind(purchase_order_id, line.item_id).all();
      for (const lot of lotsToUpdate) {
        await env.DB.prepare("UPDATE item_lots SET cost_total = ? WHERE id = ?").bind(line.rate * lot.quantity_original, lot.id).run();
      }
    }
  }

  if (purchase_order_id) {
    const { results: poItems } = await env.DB.prepare("SELECT id FROM purchase_order_items WHERE purchase_order_id = ?").bind(purchase_order_id).all();
    const { results: billedLines } = await env.DB.prepare(
      "SELECT DISTINCT sbi.purchase_order_item_id FROM supplier_bill_items sbi JOIN supplier_bills sb ON sb.id = sbi.supplier_bill_id WHERE sb.purchase_order_id = ?"
    ).bind(purchase_order_id).all();
    const billedIds = new Set(billedLines.map((b) => b.purchase_order_item_id));
    const allBilled = poItems.every((i) => billedIds.has(i.id));
    if (allBilled) await env.DB.prepare("UPDATE purchase_orders SET bill_status = 'billed' WHERE id = ?").bind(purchase_order_id).run();
  }

  const inventoryOrExpenseId = await accountFixedId(env, purchase_order_id ? "1200" : "5000");
  const jeLines = [{ account_id: inventoryOrExpenseId, debit: preTaxAmount }];
  if (totalTax > 0) jeLines.push({ account_id: await accountFixedId(env, "1300"), debit: totalTax });
  if (supplier_party_id) jeLines.push({ account_id: await getOrCreatePartyAccount(env, supplier_party_id), credit: amount });
  else jeLines.push({ account_id: await accountFixedId(env, "1000"), credit: amount });

  await postJournalEntry(env, { date: effectiveDate, description: description || `Bill from ${supplier_name}`, reference_type: "supplier_bill", reference_id: id, created_by: data.user?.name, lines: jeLines });

  return Response.json({ id, amount, pre_tax_amount: preTaxAmount, tax_amount: totalTax });
}
