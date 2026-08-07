export async function onRequestPost({ request, env, params }) {
  const form = await request.formData();
  const file = form.get("photo");
  if (!file || typeof file === "string") return Response.json({ error: "photo file is required" }, { status: 400 });

  const ext = (file.type && file.type.split("/")[1]) || "jpg";
  const key = `work-orders/${params.id}/${Date.now()}.${ext}`;

  await env.PHOTOS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
  await env.DB.prepare("INSERT INTO photos (entity_type, entity_id, r2_key) VALUES ('work_order', ?, ?)").bind(params.id, key).run();

  return Response.json({ ok: true, key, url: `/api/photo/${key}` });
}
