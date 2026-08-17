export async function onRequestPatch({ request, env, params, data }) {
  const body = await request.json();
  const redemption = await env.DB.prepare("SELECT * FROM reseller_reward_redemptions WHERE id = ?").bind(params.id).first();
  if (!redemption) return Response.json({ error: "Redemption not found" }, { status: 404 });

  if (body.status === "approved") {
    if (redemption.status !== "requested") return Response.json({ error: "Can only approve a redemption that's still requested" }, { status: 400 });
    await env.DB.prepare(
      "INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, reference_id, notes) VALUES (?, 'spent', ?, 'redemption', ?, ?)"
    ).bind(redemption.reseller_party_id, -redemption.points_spent, redemption.id, "Redeemed for reward " + redemption.reward_item_id).run();
    await env.DB.prepare("UPDATE reseller_reward_redemptions SET status = 'approved', approved_at = datetime('now') WHERE id = ?").bind(params.id).run();
    return Response.json({ ok: true });
  }

  if (body.status === "shipped") {
    if (redemption.status !== "approved") return Response.json({ error: "Can only ship a redemption that's already approved" }, { status: 400 });
    await env.DB.prepare("UPDATE reseller_reward_redemptions SET status = 'shipped', shipped_at = datetime('now'), courier = ?, tracking_id = ? WHERE id = ?")
      .bind(body.courier || null, body.tracking_id || null, params.id).run();
    return Response.json({ ok: true });
  }

  if (body.status === "rejected") {
    if (redemption.status !== "requested") return Response.json({ error: "Can only reject a redemption that hasn't been approved yet" }, { status: 400 });
    await env.DB.prepare("UPDATE reseller_reward_redemptions SET status = 'rejected' WHERE id = ?").bind(params.id).run();
    return Response.json({ ok: true });
  }

  return Response.json({ error: "status must be approved, shipped, or rejected" }, { status: 400 });
}
