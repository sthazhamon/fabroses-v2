import { postJournalEntry, getOrCreatePartyAccount, accountFixedId, nextId } from "./_ledger.js";
import { awardPointsIfSaleFullyPaid, checkMilestoneAchievements } from "./_gamification.js";

const DIRECTION_DEBIT_SIDE = { receivable: "cash", payable: "party", worker: "party" };

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const partyId = url.searchParams.get("party_id");
  let q = "SELECT * FROM payments";
  const params = [];
  if (partyId) { q += " WHERE party_id = ?"; params.push(partyId); }
  q += " ORDER BY payment_date DESC, id DESC";
  const { results } = await env.DB.prepare(q).bind(...params).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const { party_id, direction, amount, payment_date, method, reference, notes, allocations } = body;

  if (!party_id || !["receivable", "payable", "worker"].includes(direction) || amount == null) {
    return Response.json({ error: "party_id, a valid direction, and amount are required" }, { status: 400 });
  }
  const party = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(party_id).first();
  if (!party) return Response.json({ error: "Party not found" }, { status: 404 });

  const allocList = allocations || [];
  const totalAllocated = allocList.reduce((s, a) => s + a.amount_applied, 0);
  if (totalAllocated > amount + 0.001) {
    return Response.json({ error: `Allocations (${totalAllocated}) can't exceed the payment amount (${amount})` }, { status: 400 });
  }

  const id = await nextId(env, "payments", "PAY");
  const effectiveDate = payment_date || new Date().toISOString().slice(0, 10);

  await env.DB.prepare(
    "INSERT INTO payments (id, party_id, party_name, direction, amount, payment_date, method, reference, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, party_id, party.name, direction, amount, effectiveDate, method || null, reference || null, notes || null, data.user?.name || "unknown").run();

  const pointsAwards = [];
  const milestoneAchievements = [];
  for (const alloc of allocList) {
    if (!alloc.amount_applied) continue;
    await env.DB.prepare("INSERT INTO payment_allocations (payment_id, bill_type, bill_id, amount_applied) VALUES (?, ?, ?, ?)")
      .bind(id, alloc.bill_type, alloc.bill_id, alloc.amount_applied).run();
    if (alloc.bill_type === "sale") {
      const award = await awardPointsIfSaleFullyPaid(env, alloc.bill_id, data.user?.name);
      if (award) {
        pointsAwards.push(award);
        const achievements = await checkMilestoneAchievements(env, award.reseller_party_id);
        milestoneAchievements.push(...achievements);
      }
    }
  }

  if (amount > 0) {
    const partyAccountId = await getOrCreatePartyAccount(env, party_id);
    const cashId = await accountFixedId(env, "1000");
    const lines = direction === "receivable"
      ? [{ account_id: cashId, debit: amount }, { account_id: partyAccountId, credit: amount }]
      : [{ account_id: partyAccountId, debit: amount }, { account_id: cashId, credit: amount }];
    await postJournalEntry(env, { date: effectiveDate, description: notes || `Payment ${direction === "receivable" ? "from" : "to"} ${party.name}`, reference_type: "payment", reference_id: id, created_by: data.user?.name, lines });
  }

  return Response.json({ id, unallocated: Math.round((amount - totalAllocated) * 100) / 100, points_awards: pointsAwards, milestone_achievements: milestoneAchievements });
}
