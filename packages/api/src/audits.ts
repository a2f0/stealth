import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import {
  type AuditDefinition,
  isRecord,
  parseAuditDefinition,
  validText,
} from "./auditDefinition";
import {
  type AuditIssueImageRow,
  auditIssueImages,
  findAuditIssueImages,
  toAuditIssueImage,
} from "./auditIssueImages";
import type { AuthVariables } from "./authMiddleware";
import { freeFormTemplateLimit, organizationTemplateLimit } from "./billing";
import { type Db, getDb } from "./db";
import { nfpa70eStarter } from "./nfpa70eStarter";
import { residentialCoreStarter } from "./residentialAuditLibrary";
import {
  auditIssues,
  audits as auditRuns,
  auditTemplateFamilies,
  auditTemplateVersions,
  member,
  user,
} from "./schema";
import type { Bindings } from "./types";

const audits = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

interface TemplateRow {
  created_at: string;
  current_version: number;
  definition: string;
  description: string;
  id: string;
  name: string;
  scope: string;
  status: string;
  updated_at: string;
  version: number;
  version_created_at: string;
  version_created_by_email: string;
  version_created_by_id: string;
  version_created_by_name: string;
  version_id: string;
}

interface TemplateVersionRow {
  created_at: string;
  created_by_email: string;
  created_by_id: string;
  created_by_name: string;
  version: number;
}

interface TemplateSaveInput {
  definition: AuditDefinition;
  description: string;
  expectedCurrentVersion: unknown;
  name: string;
}

interface AuditRow {
  completed_at: string | null;
  created_at: string;
  definition: string;
  id: string;
  responses: string;
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
  description: string;
  id: string;
  item_id: string;
  priority: string;
  status: string;
  title: string;
  updated_at: string;
}

const templateColumns = {
  id: auditTemplateFamilies.id,
  scope: auditTemplateFamilies.scope,
  current_version: auditTemplateFamilies.currentVersion,
  created_at: auditTemplateFamilies.createdAt,
  updated_at: auditTemplateFamilies.updatedAt,
  version_id: auditTemplateVersions.id,
  version: auditTemplateVersions.version,
  name: auditTemplateVersions.name,
  description: auditTemplateVersions.description,
  definition: auditTemplateVersions.definition,
  status: auditTemplateVersions.status,
  version_created_at: auditTemplateVersions.createdAt,
  version_created_by_id: auditTemplateVersions.createdBy,
  version_created_by_name: user.name,
  version_created_by_email: user.email,
};

function selectTemplates(database: D1Database, versionJoin: SQL) {
  return getDb(database)
    .select(templateColumns)
    .from(auditTemplateFamilies)
    .innerJoin(
      auditTemplateVersions,
      and(
        eq(auditTemplateVersions.templateId, auditTemplateFamilies.id),
        versionJoin,
      ),
    )
    .innerJoin(user, eq(user.id, auditTemplateVersions.createdBy));
}

const auditColumns = {
  id: auditRuns.id,
  template_id: auditRuns.templateId,
  template_family_id: auditRuns.templateFamilyId,
  template_version: auditRuns.templateVersion,
  template_name: auditRuns.templateName,
  definition: auditRuns.definition,
  responses: auditRuns.responses,
  status: auditRuns.status,
  completed_at: auditRuns.completedAt,
  created_at: auditRuns.createdAt,
  updated_at: auditRuns.updatedAt,
};

const auditRunPageSize = 100;

const auditLibraryActor = {
  email: "audit-library@system.invalid",
  id: "system:audit-library",
  name: "Stealth audit library",
} as const;

audits.get("/templates", async (context) => {
  const organizationId = context.get("organizationId");
  await ensureStarterTemplates(context.env.DB);
  const templates = await selectTemplates(
    context.env.DB,
    eq(auditTemplateVersions.version, auditTemplateFamilies.currentVersion),
  )
    .where(
      or(
        eq(auditTemplateFamilies.scope, "global"),
        eq(auditTemplateFamilies.organizationId, organizationId),
      ),
    )
    .orderBy(desc(auditTemplateFamilies.updatedAt));
  return context.json({ templates: templates.map(toTemplate) });
});

audits.post("/templates", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body) || !validText(body.name, 200)) {
    return context.json({ error: "A template name is required." }, 400);
  }
  const scope = parseTemplateScope(body.scope);
  if (!scope) return context.json({ error: "Template scope is invalid." }, 400);
  if (
    scope === "global" &&
    !hasRole(context.get("authSession").user.role, "admin")
  ) {
    return context.json(
      { error: "Platform administrator access is required." },
      403,
    );
  }
  const definition = blankDefinition();
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const userId = context.get("authSession").user.id;
  const now = new Date().toISOString();
  const organizationId = context.get("organizationId");
  const templateLimit =
    scope === "organization"
      ? await organizationTemplateLimit(
          context.env.DB,
          organizationId,
          context.env.STRIPE_PRO_PRICE_ID,
          context.env.STRIPE_PRO_LEGACY_PRICE_IDS,
        )
      : null;
  const db = getDb(context.env.DB);
  const results = await db.batch([
    insertLimitedTemplateFamily(
      db,
      {
        id,
        organizationId: scope === "organization" ? organizationId : null,
        scope,
        userId,
        now,
      },
      organizationId,
      templateLimit,
    ),
    insertFirstTemplateVersion(db, {
      definition: JSON.stringify(definition),
      description: "",
      id: versionId,
      name: body.name.trim(),
      now,
      templateId: id,
      userId,
    }),
  ]);
  if (Number(results[0]?.meta.changes) !== 1) {
    return context.json(
      {
        error: `The Free plan is limited to ${templateLimit} form templates. Upgrade to Pro for unlimited forms.`,
      },
      409,
    );
  }
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    id,
  );
  if (!template) throw new Error("Created template could not be loaded.");
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
    return context.json(
      { error: "This template has a newer version. Reload it before saving." },
      409,
    );
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
  const versions = await getDb(context.env.DB)
    .select({
      version: auditTemplateVersions.version,
      created_at: auditTemplateVersions.createdAt,
      created_by_id: auditTemplateVersions.createdBy,
      created_by_name: user.name,
      created_by_email: user.email,
    })
    .from(auditTemplateVersions)
    .innerJoin(user, eq(user.id, auditTemplateVersions.createdBy))
    .where(eq(auditTemplateVersions.templateId, template.id))
    .orderBy(desc(auditTemplateVersions.version));
  return context.json({ versions: versions.map(toTemplateVersion) });
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

audits.put("/templates/:id", async (context) => {
  const current = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!current) return context.json({ error: "Template not found." }, 404);
  if (
    current.scope === "global" &&
    !hasRole(context.get("authSession").user.role, "admin")
  ) {
    return context.json(
      { error: "Platform administrator access is required." },
      403,
    );
  }
  const input = templateSaveInput(await context.req.json().catch(() => null));
  if (typeof input === "string") return context.json({ error: input }, 400);
  if (
    input.expectedCurrentVersion !== undefined &&
    input.expectedCurrentVersion !== current.current_version
  ) {
    return context.json(
      { error: "This template has a newer version. Reload it before saving." },
      409,
    );
  }
  const userId = context.get("authSession").user.id;
  const now = new Date().toISOString();
  try {
    await addTemplateVersion(context.env.DB, current, userId, input, now);
  } catch (cause) {
    const latest = await findTemplate(
      context.env.DB,
      context.get("organizationId"),
      current.id,
    );
    if (latest && latest.current_version !== current.current_version) {
      return context.json(
        {
          error: "This template has a newer version. Reload it before saving.",
        },
        409,
      );
    }
    throw cause;
  }
  const saved = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    current.id,
  );
  if (!saved) throw new Error("Saved template could not be loaded.");
  return context.json({ template: toTemplate(saved) });
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
  await getDb(context.env.DB)
    .insert(auditRuns)
    .values({
      id,
      organizationId: context.get("organizationId"),
      templateId: null,
      templateFamilyId: template.id,
      templateVersionId: template.version_id,
      templateVersion: template.version,
      templateName: template.name,
      definition: template.definition,
      responses: "{}",
      status: "in_progress",
      startedBy: context.get("authSession").user.id,
      createdAt: now,
      updatedAt: now,
    });
  return context.json({ auditId: id }, 201);
});

audits.get("/runs", async (context) => {
  const cursorValue = context.req.query("cursor");
  const cursor =
    cursorValue === undefined ? undefined : parseAuditCursor(cursorValue);
  if (cursorValue !== undefined && !cursor) {
    return context.json({ error: "Invalid audit cursor." }, 400);
  }
  const results = await getDb(context.env.DB)
    .select({ ...auditColumns, issue_count: count(auditIssues.id) })
    .from(auditRuns)
    .leftJoin(auditIssues, eq(auditIssues.auditId, auditRuns.id))
    .where(
      and(
        eq(auditRuns.organizationId, context.get("organizationId")),
        cursor &&
          or(
            lt(auditRuns.createdAt, cursor.createdAt),
            and(
              eq(auditRuns.createdAt, cursor.createdAt),
              lt(auditRuns.id, cursor.id),
            ),
          ),
      ),
    )
    .groupBy(auditRuns.id)
    .orderBy(desc(auditRuns.createdAt), desc(auditRuns.id))
    .limit(auditRunPageSize + 1);
  const page = results.slice(0, auditRunPageSize);
  const last = page.at(-1);
  const nextCursor =
    results.length > auditRunPageSize && last
      ? encodeAuditCursor({ createdAt: last.created_at, id: last.id })
      : null;
  return context.json({
    audits: page.map(toAuditSummary),
    nextCursor,
  });
});

audits.get("/runs/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  const [issues, members, images] = await Promise.all([
    findIssues(context.env.DB, organizationId, audit.id),
    findMembers(context.env.DB, organizationId),
    findAuditIssueImages(context.env.DB, organizationId, audit.id),
  ]);
  const imagesByIssue = groupImagesByIssue(images);
  return context.json({
    audit: toAudit(audit),
    issues: issues.map((issue) =>
      toIssue(issue, imagesByIssue.get(issue.id) ?? []),
    ),
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
  const updated = await getDb(context.env.DB)
    .update(auditRuns)
    .set({
      responses: JSON.stringify(responses),
      status,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(auditRuns.id, audit.id),
        eq(auditRuns.organizationId, organizationId),
      ),
    );
  if (Number(updated.meta.changes) !== 1) {
    return context.json({ error: "Audit not found." }, 404);
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
  await getDb(context.env.DB)
    .insert(auditIssues)
    .values({
      id,
      organizationId,
      auditId: audit.id,
      itemId: issueInput.itemId,
      title: issueInput.title,
      description: issueInput.description,
      priority: issueInput.priority,
      status: "open",
      assignedTo: issueInput.assignedTo,
      createdBy: context.get("authSession").user.id,
      createdAt: now,
      updatedAt: now,
    });
  return context.json({ issueId: id }, 201);
});

audits.patch("/issues/:id", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body))
    return context.json({ error: "Invalid issue update." }, 400);
  const organizationId = context.get("organizationId");
  const issue = await getDb(context.env.DB)
    .select({
      id: auditIssues.id,
      status: auditIssues.status,
      assignedTo: auditIssues.assignedTo,
    })
    .from(auditIssues)
    .where(
      and(
        eq(auditIssues.id, context.req.param("id")),
        eq(auditIssues.organizationId, organizationId),
      ),
    )
    .get();
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
    : issue.assignedTo;
  if (changesAssignee && assignedTo === undefined) {
    return context.json({ error: "Issue assignee is invalid." }, 400);
  }
  const status =
    body.status === "open" || body.status === "resolved"
      ? body.status
      : issue.status;
  const now = new Date().toISOString();
  const result = await updateIssue(context.env.DB, organizationId, issue.id, {
    assignedTo: changesAssignee ? assignedTo : undefined,
    status: changesStatus ? status : undefined,
    updatedAt: now,
  });
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

/** Updates an issue; a new assignee must still be a member at commit. */
async function updateIssue(
  database: D1Database,
  organizationId: string,
  id: string,
  changes: {
    assignedTo: string | null | undefined;
    status: string | undefined;
    updatedAt: string;
  },
) {
  const db = getDb(database);
  const assignee = changes.assignedTo;
  return db
    .update(auditIssues)
    .set(changes)
    .where(
      and(
        eq(auditIssues.id, id),
        eq(auditIssues.organizationId, organizationId),
        assignee == null
          ? undefined
          : exists(
              db
                .select({ one: sql`1` })
                .from(member)
                .where(
                  and(
                    eq(member.organizationId, organizationId),
                    eq(member.userId, assignee),
                  ),
                ),
            ),
      ),
    );
}

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
  const db = getDb(database);
  const results = await db.batch([
    insertLimitedTemplateFamily(
      db,
      { id, organizationId, scope: "organization", userId, now },
      organizationId,
      templateLimit,
    ),
    insertFirstTemplateVersion(db, {
      definition: JSON.stringify(input.definition),
      description: input.description,
      id: versionId,
      name: input.name,
      now,
      templateId: id,
      userId,
    }),
  ]);
  if (Number(results[0]?.meta.changes) !== 1) return null;
  const saved = await findTemplate(database, organizationId, id);
  if (!saved) throw new Error("Copied template could not be loaded.");
  return saved;
}

/** Inserts a template family only while the organization is under its limit. */
function insertLimitedTemplateFamily(
  db: Db,
  family: {
    id: string;
    organizationId: string | null;
    scope: string;
    userId: string;
    now: string;
  },
  limitOrganizationId: string,
  templateLimit: number | null,
) {
  const organizationTemplates = db
    .select({ count: count() })
    .from(auditTemplateFamilies)
    .where(
      and(
        eq(auditTemplateFamilies.scope, "organization"),
        eq(auditTemplateFamilies.organizationId, limitOrganizationId),
      ),
    );
  return db.insert(auditTemplateFamilies).select(
    sql`select ${family.id}, ${family.scope}, ${family.organizationId}, 1,
                 ${family.userId}, ${family.now}, ${family.now}
          where ${templateLimit} is null
             or ${organizationTemplates} < ${templateLimit}`,
  );
}

/** Inserts version one only when its family row was inserted. */
function insertFirstTemplateVersion(
  db: Db,
  version: {
    definition: string;
    description: string;
    id: string;
    name: string;
    now: string;
    templateId: string;
    userId: string;
  },
) {
  const family = db
    .select({ one: sql`1` })
    .from(auditTemplateFamilies)
    .where(eq(auditTemplateFamilies.id, version.templateId));
  return db.insert(auditTemplateVersions).select(
    sql`select ${version.id}, ${version.templateId}, 1, ${version.name},
                 ${version.description}, ${version.definition}, 'draft',
                 ${version.userId}, ${version.now}
          where ${exists(family)}`,
  );
}

async function addTemplateVersion(
  database: D1Database,
  current: TemplateRow,
  userId: string,
  input: TemplateSaveInput,
  now: string,
) {
  const version = current.current_version + 1;
  const db = getDb(database);
  await db.batch([
    db
      .update(auditTemplateFamilies)
      .set({ currentVersion: version, updatedAt: now })
      .where(
        and(
          eq(auditTemplateFamilies.id, current.id),
          eq(auditTemplateFamilies.currentVersion, current.current_version),
        ),
      ),
    db.insert(auditTemplateVersions).values({
      id: crypto.randomUUID(),
      templateId: current.id,
      version,
      name: input.name,
      description: input.description,
      definition: JSON.stringify(input.definition),
      status: current.status,
      createdBy: userId,
      createdAt: now,
    }),
  ]);
}

async function ensureStarterTemplates(database: D1Database) {
  const starters = [
    { id: "nfpa70e_global", ...nfpa70eStarter },
    residentialCoreStarter,
  ];
  const db = getDb(database);
  const seeded = await db
    .select({ count: count() })
    .from(auditTemplateFamilies)
    .innerJoin(
      auditTemplateVersions,
      and(
        eq(auditTemplateVersions.templateId, auditTemplateFamilies.id),
        eq(auditTemplateVersions.version, 1),
      ),
    )
    .where(
      inArray(
        auditTemplateFamilies.id,
        starters.map(({ id }) => id),
      ),
    )
    .get();
  if (Number(seeded?.count) === starters.length) return;

  const now = new Date().toISOString();
  const [first, ...rest] = starters.flatMap((starter) => [
    // The original INSERT OR IGNORE cannot join a Drizzle D1 batch. These
    // constant rows satisfy every NOT NULL and CHECK constraint, so ON
    // CONFLICT DO NOTHING skips exactly the rows OR IGNORE skipped.
    db
      .insert(auditTemplateFamilies)
      .values({
        id: starter.id,
        scope: "global",
        organizationId: null,
        currentVersion: 1,
        createdBy: auditLibraryActor.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(),
    db
      .insert(auditTemplateVersions)
      .values({
        id: `${starter.id}:v1`,
        templateId: starter.id,
        version: 1,
        name: starter.name,
        description: starter.description,
        definition: JSON.stringify(starter.definition),
        status: "published",
        createdBy: auditLibraryActor.id,
        createdAt: now,
      })
      .onConflictDoNothing(),
  ]);
  if (first) await db.batch([first, ...rest]);
}

async function findTemplate(
  database: D1Database,
  organizationId: string,
  id: string,
  version?: number,
) {
  await ensureStarterTemplates(database);
  return selectTemplates(
    database,
    version
      ? eq(auditTemplateVersions.version, version)
      : eq(auditTemplateVersions.version, auditTemplateFamilies.currentVersion),
  )
    .where(
      and(
        eq(auditTemplateFamilies.id, id),
        or(
          eq(auditTemplateFamilies.scope, "global"),
          eq(auditTemplateFamilies.organizationId, organizationId),
        ),
      ),
    )
    .get();
}

function parseTemplateScope(value: unknown) {
  if (value === undefined || value === "organization") return "organization";
  if (value === "global") return "global";
  return null;
}

function templateSaveInput(value: unknown): TemplateSaveInput | string {
  if (!isRecord(value) || !validText(value.name, 200)) {
    return "A template name is required.";
  }
  const definition = parseAuditDefinition(value.definition);
  if (!definition) return "The template definition is invalid.";
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  if (description.length > 2_000) {
    return "Descriptions are limited to 2,000 characters.";
  }
  return {
    definition,
    description,
    expectedCurrentVersion: value.expectedCurrentVersion,
    name: value.name.trim(),
  };
}

function positiveInteger(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseAssignee(value: unknown) {
  if (value === null || value === "") return null;
  return validText(value, 100) ? value.trim() : undefined;
}

function hasRole(roles: string, role: string) {
  return roles.split(",").some((candidate) => candidate.trim() === role);
}

async function findAudit(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return getDb(database)
    .select(auditColumns)
    .from(auditRuns)
    .where(
      and(eq(auditRuns.id, id), eq(auditRuns.organizationId, organizationId)),
    )
    .get();
}

async function findIssues(
  database: D1Database,
  organizationId: string,
  auditId: string,
) {
  return getDb(database)
    .select({
      id: auditIssues.id,
      item_id: auditIssues.itemId,
      title: auditIssues.title,
      description: auditIssues.description,
      priority: auditIssues.priority,
      status: auditIssues.status,
      assigned_to: auditIssues.assignedTo,
      created_at: auditIssues.createdAt,
      updated_at: auditIssues.updatedAt,
      assignee_name: user.name,
      assignee_email: user.email,
    })
    .from(auditIssues)
    .leftJoin(user, eq(user.id, auditIssues.assignedTo))
    .where(
      and(
        eq(auditIssues.auditId, auditId),
        eq(auditIssues.organizationId, organizationId),
      ),
    )
    .orderBy(desc(auditIssues.createdAt));
}

async function findMembers(database: D1Database, organizationId: string) {
  return getDb(database)
    .select({ id: user.id, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))
    .orderBy(asc(user.name));
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
    await getDb(database)
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
        ),
      )
      .get(),
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

function toTemplate(row: TemplateRow) {
  return {
    createdAt: row.created_at,
    currentVersion: row.current_version,
    definition: storedDefinition(row.definition),
    description: row.description,
    id: row.id,
    name: row.name,
    savedAt: row.version_created_at,
    savedBy: templateActor(
      row.version_created_by_id,
      row.version_created_by_name,
      row.version_created_by_email,
    ),
    scope: row.scope,
    status: row.status,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function toTemplateVersion(row: TemplateVersionRow) {
  return {
    createdAt: row.created_at,
    createdBy: templateActor(
      row.created_by_id,
      row.created_by_name,
      row.created_by_email,
    ),
    version: row.version,
  };
}

function templateActor(id: string, name: string, email: string) {
  return id === auditLibraryActor.id ? auditLibraryActor : { email, id, name };
}

function toAudit(row: AuditRow) {
  return {
    completedAt: row.completed_at,
    createdAt: row.created_at,
    definition: storedDefinition(row.definition),
    id: row.id,
    responses: JSON.parse(row.responses) as Record<string, string>,
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
