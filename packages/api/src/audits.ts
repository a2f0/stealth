import { Hono } from "hono";
import {
  type ActivityRow,
  auditAnswerActivityStatement,
  findActivity,
  toAuditAnswerActivity,
} from "./activity";
import { type AuditDefinition, isRecord, validText } from "./auditDefinition";
import {
  type AuditIssueImageRow,
  auditIssueImages,
  findAuditIssueImages,
  toAuditIssueImage,
} from "./auditIssueImages";
import {
  createTemplate,
  ensureStarterTemplates,
  findTemplate,
  listTemplateVersions,
  positiveInteger,
  saveTemplateVersion,
  staleTemplateError,
  storedDefinition,
  type TemplateRow,
  type TemplateSaveInput,
  templateSaveInput,
  templateSelect,
  toTemplate,
} from "./auditTemplates";
import type { AuthVariables } from "./authMiddleware";
import { freeFormTemplateLimit, organizationTemplateLimit } from "./billing";
import type { Bindings } from "./types";

const audits = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

interface AuditRow {
  completed_at: string | null;
  created_at: string;
  created_by_email: string;
  created_by_id: string;
  created_by_name: string;
  definition: string;
  id: string;
  responses: string;
  revision: number;
  status: string;
  template_family_id: string | null;
  template_id: string | null;
  template_name: string;
  template_version: number | null;
  updated_at: string;
}

interface AuditSummaryRow extends AuditRow {
  issue_count: number;
}

interface AuditCursor {
  createdAt: string;
  id: string;
}

interface IssueRow {
  assigned_to: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  created_at: string;
  created_by_email: string;
  created_by_id: string;
  created_by_name: string;
  description: string;
  id: string;
  item_id: string;
  priority: string;
  status: string;
  title: string;
  updated_at: string;
}

interface MemberRow {
  email: string;
  id: string;
  name: string;
}

const auditRunPageSize = 100;

audits.get("/templates", async (context) => {
  const organizationId = context.get("organizationId");
  await ensureStarterTemplates(context.env.DB);
  const result = await context.env.DB.prepare(
    `${templateSelect}
     WHERE family.scope = 'global' OR family.organization_id = ?
     ORDER BY family.updated_at DESC`,
  )
    .bind(organizationId)
    .all<TemplateRow>();
  return context.json({ templates: result.results.map(toTemplate) });
});

audits.post("/templates", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body) || !validText(body.name, 200)) {
    return context.json({ error: "A template name is required." }, 400);
  }
  // Global templates are created through Global Audits.
  if (body.scope !== undefined && body.scope !== "organization") {
    return context.json({ error: "Template scope is invalid." }, 400);
  }
  const organizationId = context.get("organizationId");
  const templateLimit = await organizationTemplateLimit(
    context.env.DB,
    organizationId,
    context.env.STRIPE_PRO_PRICE_ID,
    context.env.STRIPE_PRO_LEGACY_PRICE_IDS,
  );
  const template = await createTemplate(context.env.DB, {
    name: body.name.trim(),
    organizationId,
    templateLimit,
    userId: context.get("authSession").user.id,
  });
  if (!template) {
    return context.json(
      {
        code: "UPGRADE_REQUIRED",
        error: `The Free plan is limited to ${templateLimit} form templates. Upgrade to Pro for unlimited forms.`,
      },
      409,
    );
  }
  return context.json({ template: toTemplate(template) }, 201);
});

audits.post("/templates/:id/copies", async (context) => {
  const source = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (source?.scope !== "global") {
    return context.json({ error: "Global template not found." }, 404);
  }
  const input = templateSaveInput(await context.req.json().catch(() => null));
  if (typeof input === "string") return context.json({ error: input }, 400);
  if (
    input.expectedCurrentVersion !== undefined &&
    input.expectedCurrentVersion !== source.current_version
  ) {
    return context.json({ error: staleTemplateError }, 409);
  }
  const saved = await copyGlobalTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.get("authSession").user.id,
    input,
    new Date().toISOString(),
    await organizationTemplateLimit(
      context.env.DB,
      context.get("organizationId"),
      context.env.STRIPE_PRO_PRICE_ID,
      context.env.STRIPE_PRO_LEGACY_PRICE_IDS,
    ),
  );
  if (!saved) {
    return context.json(
      {
        code: "UPGRADE_REQUIRED",
        error: `The Free plan is limited to ${freeFormTemplateLimit} form templates. Upgrade to Pro for unlimited forms.`,
      },
      409,
    );
  }
  return context.json({ template: toTemplate(saved) }, 201);
});

audits.get("/templates/:id/versions", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  return context.json({
    versions: await listTemplateVersions(context.env.DB, template.id),
  });
});

audits.get("/templates/:id/versions/:version", async (context) => {
  const version = positiveInteger(context.req.param("version"));
  if (!version)
    return context.json({ error: "Template version is invalid." }, 400);
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
    version,
  );
  return template
    ? context.json({ template: toTemplate(template) })
    : context.json({ error: "Template version not found." }, 404);
});

audits.get("/templates/:id", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  return template
    ? context.json({ template: toTemplate(template) })
    : context.json({ error: "Template not found." }, 404);
});

audits.get("/templates/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const template = await findTemplate(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    template.scope === "global" ? null : organizationId,
    context.req.query("cursor"),
    { id: template.id, type: "audit_template" },
  );
  return page
    ? context.json(page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

audits.put("/templates/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const current = await findTemplate(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!current) return context.json({ error: "Template not found." }, 404);
  if (current.scope === "global") {
    return context.json(
      { error: "Global templates are managed from Global Audits." },
      403,
    );
  }
  const input = templateSaveInput(await context.req.json().catch(() => null));
  if (typeof input === "string") return context.json({ error: input }, 400);
  const saved = await saveTemplateVersion(
    context.env.DB,
    organizationId,
    current,
    context.get("authSession").user.id,
    input,
  );
  return saved === "stale"
    ? context.json({ error: staleTemplateError }, 409)
    : context.json({ template: toTemplate(saved) });
});

audits.post("/templates/:id/runs", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO audits
     (id, organization_id, template_id, template_family_id,
      template_version_id, template_version, template_name, definition,
      responses, status, started_by, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '{}', 'in_progress', ?, ?, ?)`,
  )
    .bind(
      id,
      context.get("organizationId"),
      template.id,
      template.version_id,
      template.version,
      template.name,
      template.definition,
      context.get("authSession").user.id,
      now,
      now,
    )
    .run();
  return context.json({ auditId: id }, 201);
});

audits.get("/runs", async (context) => {
  const cursorValue = context.req.query("cursor");
  const cursor =
    cursorValue === undefined ? undefined : parseAuditCursor(cursorValue);
  if (cursorValue !== undefined && !cursor) {
    return context.json({ error: "Invalid audit cursor." }, 400);
  }
  const result = await context.env.DB.prepare(
    `SELECT audit.id, audit.template_id, audit.template_family_id,
            audit.template_version, audit.template_name, audit.definition,
            audit.responses, audit.status, audit.completed_at,
            audit.revision, creator.id AS created_by_id,
            creator.name AS created_by_name, creator.email AS created_by_email,
            audit.created_at, audit.updated_at, COUNT(issue.id) AS issue_count
     FROM audits AS audit
     JOIN user AS creator ON creator.id = audit.started_by
     LEFT JOIN audit_issues AS issue ON issue.audit_id = audit.id
     WHERE audit.organization_id = ?
       AND (? IS NULL OR audit.created_at < ? OR
            (audit.created_at = ? AND audit.id < ?))
     GROUP BY audit.id
     ORDER BY audit.created_at DESC, audit.id DESC
     LIMIT ?`,
  )
    .bind(
      context.get("organizationId"),
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      auditRunPageSize + 1,
    )
    .all<AuditSummaryRow>();
  const page = result.results.slice(0, auditRunPageSize);
  const last = page.at(-1);
  const nextCursor =
    result.results.length > auditRunPageSize && last
      ? encodeAuditCursor({ createdAt: last.created_at, id: last.id })
      : null;
  return context.json({
    audits: page.map(toAuditSummary),
    nextCursor,
  });
});

audits.get("/runs/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const auditId = context.req.param("id");
  const [auditRows, answerRows] = await context.env.DB.batch<
    AuditRow | ActivityRow
  >([
    auditStatement(context.env.DB, organizationId, auditId),
    auditAnswerActivityStatement(context.env.DB, organizationId, auditId),
  ]);
  const audit = auditRows?.results[0] as AuditRow | undefined;
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  const answerActivity = toAuditAnswerActivity(
    (answerRows?.results ?? []) as ActivityRow[],
  );
  const [issues, members, images] = await Promise.all([
    findIssues(context.env.DB, organizationId, audit.id),
    findMembers(context.env.DB, organizationId),
    findAuditIssueImages(context.env.DB, organizationId, audit.id),
  ]);
  const imagesByIssue = groupImagesByIssue(images);
  return context.json({
    audit: { ...toAudit(audit), answerActivity },
    issues: issues.map((issue) =>
      toIssue(issue, imagesByIssue.get(issue.id) ?? []),
    ),
    members: members.map((member) => ({ ...member })),
  });
});

audits.get("/runs/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    organizationId,
    context.req.query("cursor"),
    {
      id: audit.id,
      type: "audit_run",
    },
  );
  return page
    ? context.json(page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

audits.patch("/runs/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body))
    return context.json({ error: "Invalid audit update." }, 400);
  if (
    typeof body.expectedRevision !== "number" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 0
  ) {
    return context.json(
      { error: "A valid audit revision is required. Reload it before saving." },
      400,
    );
  }
  if (body.expectedRevision !== audit.revision) {
    return context.json(
      { error: "This audit has changed. Reload it before saving." },
      409,
    );
  }
  const definition = storedDefinition(audit.definition);
  const responses = parseResponses(body.responses, definition);
  if (!responses)
    return context.json({ error: "Invalid audit responses." }, 400);
  const status = body.status ?? audit.status;
  if (status !== "completed" && status !== "in_progress") {
    return context.json({ error: "Invalid audit status." }, 400);
  }
  if (status === "completed" && !allRequiredAnswered(definition, responses)) {
    return context.json({ error: "Complete every required item first." }, 400);
  }
  const now = new Date().toISOString();
  const updated = await context.env.DB.prepare(
    `UPDATE audits SET responses = ?, status = ?, completed_at = ?, updated_at = ?,
                       activity_actor_id = ?, revision = revision + 1
     WHERE revision = ? AND id = ? AND organization_id = ?`,
  )
    .bind(
      JSON.stringify(responses),
      status,
      status === "completed" ? (audit.completed_at ?? now) : null,
      now,
      context.get("authSession").user.id,
      audit.revision,
      audit.id,
      organizationId,
    )
    .run();
  if (Number(updated.meta.changes) === 0) {
    const exists = await findAudit(context.env.DB, organizationId, audit.id);
    return exists
      ? context.json(
          { error: "This audit has changed. Reload it before saving." },
          409,
        )
      : context.json({ error: "Audit not found." }, 404);
  }
  return context.json({ status, updatedAt: now });
});

audits.post("/runs/:id/issues", async (context) => {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  const body: unknown = await context.req.json().catch(() => null);
  const issueInput = await parseIssueInput(
    context.env.DB,
    organizationId,
    storedDefinition(audit.definition),
    body,
  );
  if (!issueInput)
    return context.json({ error: "Invalid issue details." }, 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO audit_issues
     (id, organization_id, audit_id, item_id, title, description, priority,
      status, assigned_to, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      audit.id,
      issueInput.itemId,
      issueInput.title,
      issueInput.description,
      issueInput.priority,
      issueInput.assignedTo,
      context.get("authSession").user.id,
      now,
      now,
    )
    .run();
  return context.json({ issueId: id }, 201);
});

audits.patch("/issues/:id", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body))
    return context.json({ error: "Invalid issue update." }, 400);
  const organizationId = context.get("organizationId");
  const issue = await context.env.DB.prepare(
    `SELECT id, status, assigned_to
     FROM audit_issues WHERE id = ? AND organization_id = ?`,
  )
    .bind(context.req.param("id"), organizationId)
    .first<{
      assigned_to: string | null;
      id: string;
      status: string;
    }>();
  if (!issue) return context.json({ error: "Issue not found." }, 404);
  const changesStatus = body.status !== undefined;
  const changesAssignee = body.assignedTo !== undefined;
  if (!changesStatus && !changesAssignee) {
    return context.json({ error: "No issue changes were provided." }, 400);
  }
  if (
    body.status !== undefined &&
    body.status !== "open" &&
    body.status !== "resolved"
  ) {
    return context.json(
      { error: "Issue status must be open or resolved." },
      400,
    );
  }
  const assignedTo = changesAssignee
    ? parseAssignee(body.assignedTo)
    : issue.assigned_to;
  if (changesAssignee && assignedTo === undefined) {
    return context.json({ error: "Issue assignee is invalid." }, 400);
  }
  const status =
    body.status === "open" || body.status === "resolved"
      ? body.status
      : issue.status;
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `UPDATE audit_issues
     SET status = CASE WHEN ? = 1 THEN ? ELSE status END,
         assigned_to = CASE WHEN ? = 1 THEN ? ELSE assigned_to END,
         updated_at = ?, activity_actor_id = ?, revision = revision + 1
     WHERE id = ? AND organization_id = ?
       AND (? = 0 OR ? IS NULL OR EXISTS (
         SELECT 1 FROM member WHERE organizationId = ? AND userId = ?
       ))`,
  )
    .bind(
      changesStatus ? 1 : 0,
      status,
      changesAssignee ? 1 : 0,
      assignedTo ?? null,
      now,
      context.get("authSession").user.id,
      issue.id,
      organizationId,
      changesAssignee ? 1 : 0,
      assignedTo ?? null,
      organizationId,
      assignedTo ?? null,
    )
    .run();
  if (result.meta.changes > 0) {
    return context.json({ assignedTo, status, updatedAt: now });
  }
  if (
    changesAssignee &&
    assignedTo &&
    !(await isMember(context.env.DB, organizationId, assignedTo))
  ) {
    return context.json({ error: "Issue assignee is not a member." }, 400);
  }
  return context.json({ error: "Issue not found." }, 404);
});

audits.route("/issues", auditIssueImages);

async function copyGlobalTemplate(
  database: D1Database,
  organizationId: string,
  userId: string,
  input: TemplateSaveInput,
  now: string,
  templateLimit: number | null,
) {
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO audit_template_families
         (id, scope, organization_id, current_version, created_by, created_at,
          updated_at)
         SELECT ?, 'organization', ?, 1, ?, ?, ?
         WHERE ? IS NULL OR (
           SELECT COUNT(*) FROM audit_template_families
           WHERE scope = 'organization' AND organization_id = ?
         ) < ?`,
      )
      .bind(
        id,
        organizationId,
        userId,
        now,
        now,
        templateLimit,
        organizationId,
        templateLimit,
      ),
    database
      .prepare(
        `INSERT INTO audit_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at)
         SELECT ?, ?, 1, ?, ?, ?, 'draft', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM audit_template_families WHERE id = ?
         )`,
      )
      .bind(
        versionId,
        id,
        input.name,
        input.description,
        JSON.stringify(input.definition),
        userId,
        now,
        id,
      ),
  ]);
  if (Number(results[0]?.meta.changes) !== 1) return null;
  const saved = await findTemplate(database, organizationId, id);
  if (!saved) throw new Error("Copied template could not be loaded.");
  return saved;
}

function parseAssignee(value: unknown) {
  if (value === null || value === "") return null;
  return validText(value, 100) ? value.trim() : undefined;
}

async function findAudit(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return auditStatement(database, organizationId, id).first<AuditRow>();
}

function auditStatement(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT audit.id, audit.template_id, audit.template_family_id, audit.template_version,
              audit.template_name, audit.definition, audit.responses, audit.status, audit.completed_at,
              audit.created_at, audit.updated_at, audit.revision,
              creator.id AS created_by_id, creator.name AS created_by_name,
              creator.email AS created_by_email
       FROM audits AS audit JOIN user AS creator ON creator.id = audit.started_by
       WHERE audit.id = ? AND audit.organization_id = ?`,
    )
    .bind(id, organizationId);
}

async function findIssues(
  database: D1Database,
  organizationId: string,
  auditId: string,
) {
  const result = await database
    .prepare(
      `SELECT issue.id, issue.item_id, issue.title, issue.description,
              issue.priority, issue.status, issue.assigned_to, issue.created_at,
              issue.updated_at, assignee.name AS assignee_name,
              creator.id AS created_by_id, creator.name AS created_by_name,
              creator.email AS created_by_email,
              assignee.email AS assignee_email
       FROM audit_issues AS issue
       JOIN user AS creator ON creator.id = issue.created_by
       LEFT JOIN user AS assignee ON assignee.id = issue.assigned_to
       WHERE issue.audit_id = ? AND issue.organization_id = ?
       ORDER BY issue.created_at DESC`,
    )
    .bind(auditId, organizationId)
    .all<IssueRow>();
  return result.results;
}

async function findMembers(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `SELECT user.id, user.name, user.email
       FROM member JOIN user ON user.id = member.userId
       WHERE member.organizationId = ? ORDER BY user.name ASC`,
    )
    .bind(organizationId)
    .all<MemberRow>();
  return result.results;
}

async function parseIssueInput(
  database: D1Database,
  organizationId: string,
  definition: AuditDefinition,
  value: unknown,
) {
  if (!isRecord(value) || !validText(value.itemId, 100)) return null;
  if (!validText(value.title, 300)) return null;
  if (!definitionItemIds(definition).has(value.itemId)) return null;
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  if (description.length > 2_000) return null;
  const priority = ["low", "medium", "high", "critical"].includes(
    String(value.priority),
  )
    ? String(value.priority)
    : "medium";
  const assignedTo =
    typeof value.assignedTo === "string" ? value.assignedTo : null;
  if (assignedTo && !(await isMember(database, organizationId, assignedTo))) {
    return null;
  }
  return {
    assignedTo,
    description,
    itemId: value.itemId,
    priority,
    title: value.title.trim(),
  };
}

async function isMember(
  database: D1Database,
  organizationId: string,
  userId: string,
) {
  return Boolean(
    await database
      .prepare(`SELECT id FROM member WHERE organizationId = ? AND userId = ?`)
      .bind(organizationId, userId)
      .first(),
  );
}

function parseResponses(value: unknown, definition: AuditDefinition) {
  if (!isRecord(value) || Object.keys(value).length > 5_000) return null;
  const items = new Map(
    definition.sections.flatMap((section) =>
      section.items.map((item) => [item.id, item] as const),
    ),
  );
  const responses: Record<string, string> = {};
  for (const [itemId, response] of Object.entries(value)) {
    const item = items.get(itemId);
    if (!item || typeof response !== "string" || response.length > 2_000) {
      return null;
    }
    if (
      item.responseType === "check" &&
      !["pass", "fail", "na"].includes(response)
    ) {
      return null;
    }
    responses[itemId] = response;
  }
  return responses;
}

function allRequiredAnswered(
  definition: AuditDefinition,
  responses: Record<string, string>,
) {
  return definition.sections.every((section) =>
    section.items.every(
      (item) => !item.required || Boolean(responses[item.id]?.trim()),
    ),
  );
}

function definitionItemIds(definition: AuditDefinition) {
  return new Set(
    definition.sections.flatMap((section) =>
      section.items.map((item) => item.id),
    ),
  );
}

function groupImagesByIssue(images: AuditIssueImageRow[]) {
  const grouped = new Map<string, AuditIssueImageRow[]>();
  for (const image of images) {
    const issueImages = grouped.get(image.issue_id) ?? [];
    issueImages.push(image);
    grouped.set(image.issue_id, issueImages);
  }
  return grouped;
}

function encodeAuditCursor(cursor: AuditCursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function parseAuditCursor(value: string): AuditCursor | undefined {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return undefined;
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!isRecord(decoded)) return undefined;
    const createdAt: unknown = Reflect.get(decoded, "createdAt");
    if (
      typeof createdAt !== "string" ||
      createdAt.length === 0 ||
      createdAt.length > 1_000 ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0 ||
      decoded.id.length > 1_000
    ) {
      return undefined;
    }
    return { createdAt, id: decoded.id };
  } catch {
    return undefined;
  }
}

function toAudit(row: AuditRow) {
  return {
    completedAt: row.completed_at,
    createdAt: row.created_at,
    createdBy: {
      email: row.created_by_email,
      id: row.created_by_id,
      name: row.created_by_name,
    },
    definition: storedDefinition(row.definition),
    id: row.id,
    responses: JSON.parse(row.responses) as Record<string, string>,
    revision: row.revision,
    status: row.status,
    templateId: row.template_family_id ?? row.template_id,
    templateName: row.template_name,
    templateVersion: row.template_version,
    updatedAt: row.updated_at,
  };
}

function toAuditSummary(row: AuditSummaryRow) {
  const audit = toAudit(row);
  return {
    completedAt: audit.completedAt,
    createdAt: audit.createdAt,
    createdBy: audit.createdBy,
    id: audit.id,
    issueCount: row.issue_count,
    responseCount: Object.keys(audit.responses).length,
    status: audit.status,
    templateName: audit.templateName,
    templateVersion: audit.templateVersion,
    updatedAt: audit.updatedAt,
  };
}

function toIssue(row: IssueRow, images: AuditIssueImageRow[]) {
  return {
    assignedTo: row.assigned_to,
    assigneeEmail: row.assignee_email,
    assigneeName: row.assignee_name,
    createdAt: row.created_at,
    createdBy: {
      email: row.created_by_email,
      id: row.created_by_id,
      name: row.created_by_name,
    },
    description: row.description,
    id: row.id,
    images: images.map(toAuditIssueImage),
    itemId: row.item_id,
    priority: row.priority,
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

export { audits };
