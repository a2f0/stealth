import { Hono } from "hono";
import { cors } from "hono/cors";
import { adminOrganizations } from "./adminOrganizations";
import { audits } from "./audits";
import { createAuth } from "./auth";
import {
  type AuthVariables,
  requireAuth,
  requireOrganization,
  requireRole,
} from "./authMiddleware";
import { finance } from "./finance";
import { inbox } from "./inbox";
import { objects } from "./objects";
import { organizationGroups, requireCapability } from "./organizationGroups";
import type { Bindings } from "./types";

const app = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

app.use(
  "/api/*",
  cors({
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    origin: (_origin, context) => context.env.CORS_ORIGIN,
  }),
);

app.all("/api/auth/*", (context) =>
  createAuth(context.env, (promise) =>
    context.executionCtx.waitUntil(promise),
  ).handler(context.req.raw),
);

app.get("/", (context) =>
  context.json({ name: "stealth-api", documentation: "/api" }),
);

app.get("/health", (context) =>
  context.json({ status: "ok", timestamp: new Date().toISOString() }),
);

app.get("/api", (context) =>
  context.json({
    endpoints: {
      adminOrganizations: "/api/admin/organizations",
      audits: "/api/audits",
      finance: "/api/finance",
      inbox: "/api/inbox",
      objects: "/api/objects",
      organizationGroups: "/api/organization-groups",
      session: "/api/me",
      health: "/health",
    },
  }),
);

app.get("/api/me", requireAuth, (context) =>
  context.json({ user: context.get("authSession").user }),
);

app.get("/api/admin", requireAuth, requireRole("admin"), (context) =>
  context.json({ user: context.get("authSession").user }),
);

app.use("/api/admin/organizations", requireAuth, requireRole("admin"));
app.route("/api/admin/organizations", adminOrganizations);

app.use("/api/audits", requireAuth, requireOrganization);
app.use("/api/audits/*", requireAuth, requireOrganization);
app.route("/api/audits", audits);

app.use("/api/inbox", requireAuth, requireRole("admin"));
app.use("/api/inbox/*", requireAuth, requireRole("admin"));
app.route("/api/inbox", inbox);

app.use(
  "/api/finance",
  requireAuth,
  requireOrganization,
  requireCapability("finance"),
);
app.use(
  "/api/finance/*",
  requireAuth,
  requireOrganization,
  requireCapability("finance"),
);
app.route("/api/finance", finance);

app.use("/api/organization-groups", requireAuth, requireOrganization);
app.use("/api/organization-groups/*", requireAuth, requireOrganization);
app.route("/api/organization-groups", organizationGroups);

app.use("/api/objects", requireAuth, requireOrganization);
app.use("/api/objects/*", requireAuth, requireOrganization);
app.route("/api/objects", objects);

app.notFound((context) => context.json({ error: "Not found." }, 404));

app.onError((error, context) => {
  console.error(error);
  return context.json({ error: "Unexpected server error." }, 500);
});

export { app };
