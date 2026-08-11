import { verifyToken } from "./_auth.js";

const RULES = [
  { prefix: "/api/auth/", roles: null },
  { prefix: "/api/photo/", roles: null },
  { prefix: "/api/sites", roles: ["admin", "accountant", "dispatch"] },
  { prefix: "/api/users", roles: ["admin"] },
  { prefix: "/api/reports/", roles: ["admin", "accountant"] },
  { prefix: "/api/ledger", roles: ["admin", "accountant"] },
  { prefix: "/api/expenses", roles: ["admin", "accountant"] },
  { prefix: "/api/purchases", roles: ["admin", "accountant"] },
  { prefix: "/api/refunds", roles: ["admin", "accountant"] },
  { prefix: "/api/sale-returns", roles: ["admin", "accountant"] },
  { prefix: "/api/payments", roles: ["admin", "accountant"] },
  { prefix: "/api/outstanding-bills", roles: ["admin", "accountant"] },
  { prefix: "/api/supplier-bills", roles: ["admin", "accountant"] },
  { prefix: "/api/expense-categories", roles: ["admin", "accountant"] },
  { prefix: "/api/journal-entries", roles: ["admin", "accountant"] },
  { prefix: "/api/accounts", roles: ["admin", "accountant"] },
  { prefix: "/api/material-issues", roles: ["admin", "accountant", "dispatch", "worker"] },
  { prefix: "/api/rework-issues", roles: ["admin", "accountant", "dispatch", "worker"] },
  { prefix: "/api/parties", roles: ["admin", "accountant"] },
  { prefix: "/api/sales", roles: ["admin", "accountant", "dispatch"] },
  { prefix: "/api/dispatches", roles: ["admin", "accountant", "dispatch", "worker"] },
  { prefix: "/api/dispatch-queue", roles: ["admin", "accountant", "dispatch"] },
  { prefix: "/api/receive-history", roles: ["admin", "accountant", "dispatch"] },
  { prefix: "/api/purchase-orders", roles: ["admin", "accountant", "dispatch"] },
  { prefix: "/api/purchase-order-items", roles: ["admin", "accountant", "dispatch"] },
  { prefix: "/api/customer-orders", roles: ["admin", "accountant", "dispatch"] },
  { prefix: "/api/material-inward", roles: ["admin", "accountant", "dispatch"] },
  { prefix: "/api/worker-place", roles: ["admin", "worker"] },
  // default: any signed-in staff member except reseller (items, sites read,
  // work-orders, item-lots, item-categories/fabrics/worktypes/patterns/designs)
  { prefix: "/api/", roles: ["admin", "accountant", "worker", "dispatch"] },
];

function rolesFor(pathname) {
  for (const rule of RULES) {
    if (pathname.startsWith(rule.prefix)) return rule.roles;
  }
  return ["admin"];
}

export async function onRequest(context) {
  const { request, env, data, next } = context;
  const url = new URL(request.url);
  const allowedRoles = rolesFor(url.pathname);

  if (allowedRoles === null) return next();

  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return Response.json({ error: "Please sign in." }, { status: 401 });

  const secret = env.AUTH_SECRET || "dev-secret-change-me";
  const payload = await verifyToken(token, secret);
  if (!payload) return Response.json({ error: "Session expired, please sign in again." }, { status: 401 });

  if (!allowedRoles.includes(payload.role)) {
    return Response.json({ error: "Your account doesn't have access to this." }, { status: 403 });
  }

  const current = await env.DB.prepare("SELECT token_version, active FROM users WHERE id = ?").bind(payload.id).first();
  if (!current || current.active !== 1) {
    return Response.json({ error: "This login has been disabled. Contact an admin." }, { status: 401 });
  }
  if (current.token_version !== payload.tokenVersion) {
    return Response.json({ error: "This session was signed out remotely. Please sign in again." }, { status: 401 });
  }

  data.user = payload;
  const response = await next();
  response.headers.set("Cache-Control", "no-store");
  return response;
}
