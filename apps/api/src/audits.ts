import { Hono } from "hono";
import {
  type AuditDefinition,
  isRecord,
  parseAuditDefinition,
  validText,
} from "./auditDefinition";
import type { AuthVariables } from "./authMiddleware";
import { nfpa70eStarter } from "./nfpa70eStarter";
import type { Bindings } from "./types";

const audits = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

interface TemplateRow {
  created_at: string;
  definition: string;
  description: string;
  id: string;
  name: string;
  status: string;
  updated_at: string;
}

interface AuditRow {
  completed_at: string | null;
  created_at: string;
  definition: string;
  id: string;
  responses: string;
  status: string;
  template_id: string | null;
  template_name: string;
  updated_at: string;
}

interface AuditSummaryRow extends AuditRow {
  issue_count: number;
}

interface IssueRow {
  assigned_to: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  created_at: string;
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

audits.get("/templates", async (context) => {
  const organizationId = context.get("organizationId");
  const userId = context.get("authSession").user.id;
  await ensureStarterTemplate(context.env.DB, organizationId, userId);
  const result = await context.env.DB.prepare(
    `SELECT id, name, description, definition, status, created_at, updated_at
     FROM audit_templates
     WHERE organization_id = ?
     ORDER BY updated_at DESC`,
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
  const definition = blankDefinition();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO audit_templates
     (id, organization_id, name, description, definition, status, created_by,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
  )
    .bind(
      id,
      context.get("organizationId"),
      body.name.trim(),
      "",
      JSON.stringify(definition),
      context.get("authSession").user.id,
      now,
      now,
    )
    .run();
  return context.json(
    {
      template: {
        createdAt: now,
        definition,
        description: "",
        id,
        name: body.name.trim(),
        status: "draft",
        updatedAt: now,
      },
    },
    201,
  );
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

audits.put("/templates/:id", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body) || !validText(body.name, 200)) {
    return context.json({ error: "A template name is required." }, 400);
  }
  const definition = parseAuditDefinition(body.definition);
  if (!definition) {
    return context.json({ error: "The template definition is invalid." }, 400);
  }
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > 2_000) {
    return context.json(
      { error: "Descriptions are limited to 2,000 characters." },
      400,
    );
  }
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `UPDATE audit_templates
     SET name = ?, description = ?, definition = ?, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(
      body.name.trim(),
      description,
      JSON.stringify(definition),
      now,
      context.req.param("id"),
      context.get("organizationId"),
    )
    .run();
  return result.meta.changes > 0
    ? context.json({ updatedAt: now })
    : context.json({ error: "Template not found." }, 404);
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
     (id, organization_id, template_id, template_name, definition, responses,
      status, started_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', 'in_progress', ?, ?, ?)`,
  )
    .bind(
      id,
      context.get("organizationId"),
      template.id,
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
  const result = await context.env.DB.prepare(
    `SELECT audit.id, audit.template_id, audit.template_name, audit.definition,
            audit.responses, audit.status, audit.completed_at, audit.created_at,
            audit.updated_at, COUNT(issue.id) AS issue_count
     FROM audits AS audit
     LEFT JOIN audit_issues AS issue ON issue.audit_id = audit.id
     WHERE audit.organization_id = ?
     GROUP BY audit.id
     ORDER BY audit.created_at DESC
     LIMIT 100`,
  )
    .bind(context.get("organizationId"))
    .all<AuditSummaryRow>();
  return context.json({ audits: result.results.map(toAuditSummary) });
});

audits.get("/runs/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  const [issues, members] = await Promise.all([
    findIssues(context.env.DB, organizationId, audit.id),
    findMembers(context.env.DB, organizationId),
  ]);
  return context.json({
    audit: toAudit(audit),
    issues: issues.map(toIssue),
    members: members.map((member) => ({ ...member })),
  });
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
  const definition = storedDefinition(audit.definition);
  const responses = parseResponses(body.responses, definition);
  if (!responses)
    return context.json({ error: "Invalid audit responses." }, 400);
  const status = body.status === "completed" ? "completed" : "in_progress";
  if (status === "completed" && !allRequiredAnswered(definition, responses)) {
    return context.json({ error: "Complete every required item first." }, 400);
  }
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `UPDATE audits SET responses = ?, status = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(
      JSON.stringify(responses),
      status,
      status === "completed" ? now : null,
      now,
      audit.id,
      organizationId,
    )
    .run();
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
  if (
    !isRecord(body) ||
    (body.status !== "open" && body.status !== "resolved")
  ) {
    return context.json(
      { error: "Issue status must be open or resolved." },
      400,
    );
  }
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `UPDATE audit_issues SET status = ?, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(
      body.status,
      now,
      context.req.param("id"),
      context.get("organizationId"),
    )
    .run();
  return result.meta.changes > 0
    ? context.json({ status: body.status, updatedAt: now })
    : context.json({ error: "Issue not found." }, 404);
});

async function ensureStarterTemplate(
  database: D1Database,
  organizationId: string,
  userId: string,
) {
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT OR IGNORE INTO audit_templates
       (id, organization_id, name, description, definition, status, created_by,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
    )
    .bind(
      `nfpa70e_${organizationId}`,
      organizationId,
      nfpa70eStarter.name,
      nfpa70eStarter.description,
      JSON.stringify(nfpa70eStarter.definition),
      userId,
      now,
      now,
    )
    .run();
}

async function findTemplate(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id, name, description, definition, status, created_at, updated_at
       FROM audit_templates WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<TemplateRow>();
}

async function findAudit(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id, template_id, template_name, definition, responses, status,
              completed_at, created_at, updated_at
       FROM audits WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<AuditRow>();
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
              assignee.email AS assignee_email
       FROM audit_issues AS issue
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

function blankDefinition(): AuditDefinition {
  return {
    sections: [
      {
        id: crypto.randomUUID(),
        items: [
          {
            id: crypto.randomUUID(),
            prompt: "Untitled question",
            required: true,
            responseType: "check",
          },
        ],
        title: "Untitled section",
      },
    ],
    version: 1,
  };
}

function storedDefinition(value: string) {
  const definition = parseAuditDefinition(JSON.parse(value));
  if (!definition) throw new Error("Stored audit definition is invalid.");
  return definition;
}

function definitionItemIds(definition: AuditDefinition) {
  return new Set(
    definition.sections.flatMap((section) =>
      section.items.map((item) => item.id),
    ),
  );
}

function toTemplate(row: TemplateRow) {
  return {
    createdAt: row.created_at,
    definition: storedDefinition(row.definition),
    description: row.description,
    id: row.id,
    name: row.name,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function toAudit(row: AuditRow) {
  return {
    completedAt: row.completed_at,
    createdAt: row.created_at,
    definition: storedDefinition(row.definition),
    id: row.id,
    responses: JSON.parse(row.responses) as Record<string, string>,
    status: row.status,
    templateId: row.template_id,
    templateName: row.template_name,
    updatedAt: row.updated_at,
  };
}

function toAuditSummary(row: AuditSummaryRow) {
  const audit = toAudit(row);
  return {
    completedAt: audit.completedAt,
    createdAt: audit.createdAt,
    id: audit.id,
    issueCount: row.issue_count,
    responseCount: Object.keys(audit.responses).length,
    status: audit.status,
    templateName: audit.templateName,
    updatedAt: audit.updatedAt,
  };
}

function toIssue(row: IssueRow) {
  return {
    assignedTo: row.assigned_to,
    assigneeEmail: row.assignee_email,
    assigneeName: row.assignee_name,
    createdAt: row.created_at,
    description: row.description,
    id: row.id,
    itemId: row.item_id,
    priority: row.priority,
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

export { audits };
