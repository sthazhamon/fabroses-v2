export async function onRequestGet({ env }) {
  const { results: sites } = await env.DB.prepare(
    `SELECT s.*, u.name AS worker_name FROM sites s LEFT JOIN users u ON u.id = s.worker_user_id WHERE s.active = 1`
  ).all();

  const { results: lots } = await env.DB.prepare(
    `SELECT l.*, i.name AS item_name, i.item_code, i.item_type, i.unit_of_measure
     FROM item_lots l LEFT JOIN items i ON i.id = l.item_id
     WHERE l.quantity_balance > 0
     ORDER BY l.site_id, i.item_type, l.created_at ASC`
  ).all();

  const bySite = {};
  for (const site of sites) bySite[site.id] = { site, lots: [] };
  for (const lot of lots) {
    if (bySite[lot.site_id]) bySite[lot.site_id].lots.push(lot);
  }

  return Response.json({ sites: Object.values(bySite) });
}
