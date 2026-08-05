export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT a.*, p.name AS parent_name, pty.name AS party_name FROM accounts a
     LEFT JOIN accounts p ON p.id = a.parent_account_id
     LEFT JOIN parties pty ON pty.id = a.party_id
     ORDER BY a.code ASC, a.name ASC`
  ).all();
  return Response.json(results);
}
