import { resolveItemId } from "../../_bom.js";

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { item_id, lot_id } = body;
  if (!item_id || !lot_id) return Response.json({ error: "item_id and lot_id are required" }, { status: 400 });

  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(params.id).first();
  if (!issue) return Response.json({ error: "Material issue not found" }, { status: 404 });

  const expectedLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(issue.lot_id).first();
  if (!expectedLot) return Response.json({ error: "The expected lot record is missing — can't verify" }, { status: 400 });

  const resolvedItemId = await resolveItemId(env, item_id);
  if (lot_id !== issue.lot_id || resolvedItemId !== expectedLot.item_id) {
    return Response.json({ error: "Wrong raw material selected for this work order — that item/lot doesn't match what was issued" }, { status: 400 });
  }

  await env.DB.prepare("UPDATE material_issues SET verified_at = datetime('now') WHERE id = ?").bind(params.id).run();
  return Response.json({ ok: true });
}
