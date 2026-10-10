import { Hono } from "hono";
import { findActivity } from "./activity";
import { isRecord, validText } from "./auditDefinition";
import {
  createTemplate,
  ensureStarterTemplates,
  findTemplate,
  listTemplateVersions,
  positiveInteger,
  saveTemplateVersion,
  staleTemplateError,
  type TemplateRow,
  templateSaveInput,
  templateSelect,
  toTemplate,
} from "./auditTemplates";
import type { AuthVariables } from "./authMiddleware";
import type { Bindings } from "./types";

/**
 * Global audit templates, shared by every organization. Platform admins
 * manage them here, outside any organization; organizations can only read
 * and copy them.
 */
const adminAuditTemplates = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

adminAuditTemplates.get("/", async (context) => {
  await ensureStarterTemplates(context.env.DB);
  const result = await context.env.DB.prepare(
    `${templateSelect}
     WHERE family.scope = 'global'
     ORDER BY family.updated_at DESC`,
  ).all<TemplateRow>();
  return context.json({ templates: result.results.map(toTemplate) });
});

adminAuditTemplates.post("/", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body) || !validText(body.name, 200)) {
    return context.json({ error: "A template name is required." }, 400);
  }
  const template = await createTemplate(context.env.DB, {
    name: body.name.trim(),
    organizationId: null,
    templateLimit: null,
    userId: context.get("authSession").user.id,
  });
  if (!template) throw new Error("Global template could not be created.");
  return context.json({ template: toTemplate(template) }, 201);
});

adminAuditTemplates.get("/:id/versions", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  return context.json({
    versions: await listTemplateVersions(context.env.DB, template.id),
  });
});

adminAuditTemplates.get("/:id/versions/:version", async (context) => {
  const version = positiveInteger(context.req.param("version"));
  if (!version)
    return context.json({ error: "Template version is invalid." }, 400);
  const template = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
    version,
  );
  return template
    ? context.json({ template: toTemplate(template) })
    : context.json({ error: "Template version not found." }, 404);
});

adminAuditTemplates.get("/:id/activity", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    null,
    context.req.query("cursor"),
    { id: template.id, type: "audit_template" },
  );
  return page
    ? context.json(page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

adminAuditTemplates.get("/:id", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  return template
    ? context.json({ template: toTemplate(template) })
    : context.json({ error: "Template not found." }, 404);
});

adminAuditTemplates.put("/:id", async (context) => {
  const current = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  if (!current) return context.json({ error: "Template not found." }, 404);
  const input = templateSaveInput(await context.req.json().catch(() => null));
  if (typeof input === "string") return context.json({ error: input }, 400);
  const saved = await saveTemplateVersion(
    context.env.DB,
    null,
    current,
    context.get("authSession").user.id,
    input,
  );
  return saved === "stale"
    ? context.json({ error: staleTemplateError }, 409)
    : context.json({ template: toTemplate(saved) });
});

export { adminAuditTemplates };
