import { postJournalEntry, getOrCreatePartyAccount, accountFixedId, nextId } from "./_ledger.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare("SELECT * FROM supplier_bills ORDER BY bill_date DESC, id DESC").all();
  return Response.json(results);
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const { purchase_order_id, supplier_party_id, supplier_name, bill_number, bill_date, amount, description } = body;
  if (!amount || !supplier_name) return Response.json({ error: "supplier_name and amount are required" }, { status: 400 });

  if (purchase_order_id) {
    const po = await env.DB.prepare("SELECT * FROM purchase_orders WHERE id = ?").bind(purchase_order_id).first();
    if (!po) return Response.json({ error: "Purchase order not found" }, { status: 404 });
    if (po.status !== "received") return Response.json({ error: "Only fully-received purchase orders can have a bill entered against them" }, { status: 400 });
    await env.DB.prepare("UPDATE purchase_orders SET bill_status = 'billed' WHERE id = ?").bind(purchase_order_id).run();
  }

  const id = await nextId(env, "supplier_bills", "SBILL");
  const effectiveDate = bill_date || new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO supplier_bills (id, purchase_order_id, supplier_party_id, supplier_name, bill_number, bill_date, amount, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, purchase_order_id || null, supplier_party_id || null, supplier_name, bill_number || null, effectiveDate, amount, description || null).run();

  const inventoryOrExpenseId = await accountFixedId(env, purchase_order_id ? "1200" : "5000"); // PO-linked = raw material inventory; cash purchase defaults to generic expense
  const lines = [{ account_id: inventoryOrExpenseId, debit: amount }];
  if (supplier_party_id) lines.push({ account_id: await getOrCreatePartyAccount(env, supplier_party_id), credit: amount });
  else lines.push({ account_id: await accountFixedId(env, "1000"), credit: amount }); // no party = paid in cash immediately

  await postJournalEntry(env, { date: effectiveDate, description: description || `Bill from ${supplier_name}`, reference_type: "supplier_bill", reference_id: id, created_by: data.user?.name, lines });

  return Response.json({ id });
}
