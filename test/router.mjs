import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";

function walk(dir, base = "") {
  let routes = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      routes.push(...walk(full, base + "/" + entry));
    } else if (entry.endsWith(".js") && !entry.startsWith("_")) {
      routes.push({ file: full, relPath: base + "/" + entry.replace(/\.js$/, "") });
    }
  }
  return routes;
}

function toPattern(relPath) {
  const segments = relPath.split("/").filter(Boolean);
  return segments.map((seg) => {
    const catchAll = seg.match(/^\[\[(\w+)\]\]$/);
    if (catchAll) return { type: "catchall", name: catchAll[1] };
    const dyn = seg.match(/^\[(\w+)\]$/);
    if (dyn) return { type: "param", name: dyn[1] };
    return { type: "literal", value: seg };
  });
}

function matchRoute(pattern, pathSegments) {
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.type === "catchall") {
      params[p.name] = pathSegments.slice(i);
      return params;
    }
    if (i >= pathSegments.length) return null;
    if (p.type === "literal" && p.value !== pathSegments[i]) return null;
    if (p.type === "param") params[p.name] = pathSegments[i];
  }
  if (pattern.length !== pathSegments.length) return null;
  return params;
}

export async function buildRouter(apiDir) {
  const routeFiles = walk(apiDir, "/api");
  const routes = [];
  for (const rf of routeFiles) {
    const mod = await import("file://" + rf.file);
    routes.push({ pattern: toPattern(rf.relPath), mod, specificity: rf.relPath.split("[").length });
  }
  // Prefer more literal (less dynamic) routes when multiple could match.
  routes.sort((a, b) => a.specificity - b.specificity);

  const middlewarePath = join(apiDir, "_middleware.js");
  let middleware = null;
  try {
    statSync(middlewarePath);
    middleware = (await import("file://" + middlewarePath)).onRequest;
  } catch (e) { /* no middleware */ }

  return { routes, middleware };
}

export function findMatch(router, pathname) {
  const segments = pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const fullSegments = ["api", ...segments];
  for (const route of router.routes) {
    const params = matchRoute(route.pattern, fullSegments);
    if (params) return { mod: route.mod, params };
  }
  return null;
}

export function startServer(router, env, port) {
  const server = http.createServer(async (nodeReq, nodeRes) => {
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const bodyBuf = Buffer.concat(chunks);
    const url = "http://localhost:" + port + nodeReq.url;
    const headers = new Headers();
    for (const [k, v] of Object.entries(nodeReq.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);

    const hasBody = bodyBuf.length > 0 && !["GET", "HEAD"].includes(nodeReq.method);
    const request = new Request(url, { method: nodeReq.method, headers, body: hasBody ? bodyBuf : undefined });

    const parsedUrl = new URL(url);
    const match = findMatch(router, parsedUrl.pathname);

    const data = {};
    const respond = async () => {
      if (!match) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      const methodFnName = "onRequest" + nodeReq.method.charAt(0) + nodeReq.method.slice(1).toLowerCase();
      const fn = match.mod[methodFnName];
      if (!fn) return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
      return fn({ request, env, params: match.params, data });
    };

    let response;
    try {
      if (router.middleware) {
        response = await router.middleware({ request, env, data, next: respond });
      } else {
        response = await respond();
      }
    } catch (e) {
      response = new Response(JSON.stringify({ error: "server error: " + e.message }), { status: 500 });
    }

    nodeRes.statusCode = response.status;
    response.headers.forEach((v, k) => nodeRes.setHeader(k, v));
    const buf = Buffer.from(await response.arrayBuffer());
    nodeRes.end(buf);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
