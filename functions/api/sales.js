import { createSale } from "./_sales.js";

export async function onRequestGet({ env }) {
  const { results: sales } = await env.DB.prepare("SELECT * FROM sales ORDER BY sale_date DESC, id DESC").all();
  const withLines = [];
  for (const sale of sales) {
    const { results: lines } = await env.DB.prepare("SELECT * FROM sale_items WHERE sale_id = ?").bind(sale.id).all();
    withLines.push({ ...sale, lines });
  }
  return Response.json(withLines);
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
