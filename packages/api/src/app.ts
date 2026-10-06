import { Hono } from "hono";
import { cors } from "hono/cors";
import { accountSettings } from "./accountSettings";
import { activity } from "./activity";
import { adminJobs } from "./adminJobs";
import { adminOrganizations } from "./adminOrganizations";
import { audits } from "./audits";
import { createAuth } from "./auth";
import {
  type AuthVariables,
  requireAuth,
  requireAuthOrganizationSeat,
  requireOrganization,
  requireOrganizationPluginAccess,
  requireRole,
} from "./authMiddleware";
import { billing, handleStripeWebhook, syncOrganizationSeats } from "./billing";
import { businesses } from "./businesses";
import { handleCheckrWebhook } from "./checkrSync";
import { contracts } from "./contracts";
import { employeeForms } from "./employeeForms";
import { equipment } from "./equipment";
import { finance } from "./finance";
import { inbox } from "./inbox";
import { libraryFolders } from "./libraryFolders";
import { objects } from "./objects";
import { organizationGroups, requireCapability } from "./organizationGroups";
import { organizationSettings } from "./organizationSettings";
import { signing } from "./signing";
import type { Bindings } from "./types";
import { userDeletion } from "./userDeletion";

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
    exposeHeaders: ["Retry-After", "X-Document-Revision"],
    origin: (_origin, context) => context.env.CORS_ORIGIN,
  }),
);

app.use(
  "/api/auth/organization/*",
  requireAuth,
  requireOrganizationPluginAccess,
  requireAuthOrganizationSeat,
);
app.post("/api/auth/organization/leave", async (context) => {
  const input = (await context.req.raw
    .clone()
    .json()
    .catch(() => null)) as { organizationId?: unknown } | null;
  const response = await createAuth(context.env, (promise) =>
    context.executionCtx.waitUntil(promise),
  ).handler(context.req.raw);
  if (response.ok && typeof input?.organizationId === "string") {
    context.executionCtx.waitUntil(
      syncOrganizationSeats(context.env, input.organizationId).catch(
        (cause) => {
          console.error("Could not synchronize Stripe seat quantity.", cause);
        },
      ),
    );
  }
  return response;
});
app.all("/api/auth/*", (context) =>
  createAuth(context.env, (promise) =>
    context.executionCtx.waitUntil(promise),
  ).handler(context.req.raw),
);

app.get("/", (context) =>
  context.json({ name: "tearleads-api", documentation: "/api" }),
);

app.get("/health", (context) =>
  context.json({ status: "ok", timestamp: new Date().toISOString() }),
);

app.get("/api", (context) =>
  context.json({
    endpoints: {
      adminJobs: "/api/admin/jobs",
      adminOrganizations: "/api/admin/organizations",
      accountSettings: "/api/account-settings",
      activity: "/api/activity",
      audits: "/api/audits",
      billing: "/api/billing",
      businesses: "/api/businesses",
      contracts: "/api/contracts",
      equipment: "/api/equipment",
      employeeForms: "/api/employee-forms",
      finance: "/api/finance",
      inbox: "/api/inbox",
      libraryFolders: "/api/library/folders",
      objects: "/api/objects",
      organizationGroups: "/api/organization-groups",
      organizationSettings: "/api/organization-settings",
      session: "/api/me",
      signing: "/api/signing/:token",
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

app.use("/api/account-settings/*", requireAuth);
app.route("/api/account-settings", accountSettings);
app.route("/api/account-settings/deletion", userDeletion);

app.use("/api/admin/jobs", requireAuth);
app.use("/api/admin/jobs/*", requireAuth);
app.route("/api/admin/jobs", adminJobs);

app.use("/api/admin/organizations", requireAuth, requireRole("admin"));
app.use("/api/admin/organizations/*", requireAuth, requireRole("admin"));
app.route("/api/admin/organizations", adminOrganizations);

app.use("/api/audits", requireAuth, requireOrganization);
app.use("/api/audits/*", requireAuth, requireOrganization);
app.route("/api/audits", audits);

app.use("/api/activity", requireAuth, requireOrganization);
app.use("/api/activity/*", requireAuth, requireOrganization);
app.route("/api/activity", activity);

app.use("/api/businesses", requireAuth, requireOrganization);
app.use("/api/businesses/*", requireAuth, requireOrganization);
app.route("/api/businesses", businesses);

app.use("/api/contracts", requireAuth, requireOrganization);
app.use("/api/contracts/*", requireAuth, requireOrganization);
app.route("/api/contracts", contracts);

// Signers reach these through emailed links; the token is the credential.
app.route("/api/signing", signing);

app.use("/api/equipment", requireAuth, requireOrganization);
app.use("/api/equipment/*", requireAuth, requireOrganization);
app.route("/api/equipment", equipment);

// Checkr signs these with the account API key; no session is involved.
app.post("/api/checkr/webhook", handleCheckrWebhook);

app.use("/api/employee-forms", requireAuth, requireOrganization);
app.use("/api/employee-forms/*", requireAuth, requireOrganization);
app.route("/api/employee-forms", employeeForms);

app.post("/api/billing/webhook", handleStripeWebhook);
app.use("/api/billing", requireAuth, requireOrganization);
app.use("/api/billing/*", requireAuth, requireOrganization);
app.route("/api/billing", billing);

app.use("/api/inbox", requireAuth, requireOrganization);
app.use("/api/inbox/*", requireAuth, requireOrganization);
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

app.use("/api/organization-settings", requireAuth);
app.use("/api/organization-settings/*", requireAuth);
app.use("/api/organization-settings/people", requireOrganization);
app.use("/api/organization-settings/people/*", requireOrganization);
app.use("/api/organization-settings/current", requireOrganization);
app.route("/api/organization-settings", organizationSettings);

app.use("/api/library/folders", requireAuth, requireOrganization);
app.use("/api/library/folders/*", requireAuth, requireOrganization);
app.route("/api/library/folders", libraryFolders);

app.use("/api/objects", requireAuth, requireOrganization);
app.use("/api/objects/*", requireAuth, requireOrganization);
app.route("/api/objects", objects);

app.notFound((context) => context.json({ error: "Not found." }, 404));

app.onError((error, context) => {
  console.error(error);
  return context.json({ error: "Unexpected server error." }, 500);
});

export { app };
