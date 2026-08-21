export async function onRequestGet({ env, params }) {
  const bill = await env.DB.prepare("SELECT * FROM supplier_bills WHERE id = ?").bind(params.id).first();
  if (!bill) return Response.json({ error: "Bill not found" }, { status: 404 });

  const { results: items } = await env.DB.prepare(
    "SELECT sbi.*, i.name AS item_name, i.item_code FROM supplier_bill_items sbi LEFT JOIN items i ON i.id = sbi.item_id WHERE sbi.supplier_bill_id = ?"
  ).bind(params.id).all();

  return Response.json({ ...bill, items });
}
