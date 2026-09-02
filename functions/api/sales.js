import { createSale } from "./_sales.js";

export async function onRequestGet({ env }) {
  const { results: sales } = await env.DB.prepare("SELECT * FROM sales ORDER BY sale_date DESC, id DESC").all();
  if (!sales.length) return Response.json([]);

  const saleIds = sales.map((s) => s.id);
  const placeholders = saleIds.map(() => "?").join(",");
  const { results: allLines } = await env.DB.prepare(
    `SELECT si.*, i.name AS item_name, i.item_code FROM sale_items si LEFT JOIN items i ON i.id = si.item_id WHERE si.sale_id IN (${placeholders})`
  ).bind(...saleIds).all();

  const linesBySale = {};
  for (const line of allLines) {
    if (!linesBySale[line.sale_id]) linesBySale[line.sale_id] = [];
    linesBySale[line.sale_id].push(line);
  }

  return Response.json(sales.map((sale) => ({ ...sale, lines: linesBySale[sale.id] || [] })));
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  try {
    const res = await createSale(env, { ...body, created_by: data.user?.name });
    return Response.json(res);
  } catch (e) {
    if (e.status) return Response.json({ error: e.error }, { status: e.status });
    return Response.json({ error: e.message }, { status: 400 });
  }
}
