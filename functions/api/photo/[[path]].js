export async function onRequestGet({ params, env }) {
  const key = Array.isArray(params.path) ? params.path.join("/") : params.path;
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: { "content-type": obj.httpMetadata?.contentType || "image/jpeg", "cache-control": "public, max-age=31536000" },
  });
}
