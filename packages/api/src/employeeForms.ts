import {
  and,
  asc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import {
  cancelCheckrInvitation,
  checkrConfigured,
  checkrPackage,
  createCheckrCandidate,
  createCheckrInvitation,
  getCheckrInvitation,
  getCheckrReport,
  isDefinitiveCheckrRejection,
  listCheckrCandidateInvitations,
} from "./checkr";
import { type Db, getDb } from "./db";
import { normalizeFilename } from "./filenames";
import { canManageOrganization } from "./organizationMembers";
import {
  deletedObjectCleanup,
  employeeRequirements,
  invitation,
  member,
  user,
} from "./schema";
import type { Bindings } from "./types";

type RequirementKind = "form" | "background_check" | "credit_check";
type RequirementStatus = "pending" | "in_progress" | "submitted" | "complete";
interface RequirementInput {
  dueDate: string;
  kind: RequirementKind;
  title: string;
}
interface RequirementRow {
  id: string;
  kind: RequirementKind;
  title: string;
  due_date: string;
  status: RequirementStatus;
  document_key: string | null;
  document_filename: string | null;
  document_size: number | null;
  document_revision: number;
  invitation_id: string | null;
  invitation_status: string | null;
  member_id: string | null;
  target_email: string | null;
  target_name: string | null;
  completed_at: string | null;
  checkr_candidate_id: string | null;
  checkr_invitation_id: string | null;
  checkr_report_id: string | null;
  checkr_result: string | null;
  checkr_invitation_status: string | null;
  checkr_starting_at: string | null;
  checkr_start_nonce: string | null;
  checkr_start_nonce_at: string | null;
  checkr_start_package: string | null;
  checkr_attempt: number;
  checkr_refresh_revision: number;
}

type EmployeeFormsEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
const employeeForms = new Hono<EmployeeFormsEnv>();
const maxDocumentBytes = 10 * 1024 * 1024;
const maxMultipartBytes = maxDocumentBytes + 256 * 1024;
const documentTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
const expiredCheckrStatuses = [
  "expired",
  "canceled",
  "deleted",
  "partially_canceled",
];
const targetUser = alias(user, "target");

function selectRequirements(db: Db) {
  return db
    .select({
      id: employeeRequirements.id,
      kind: employeeRequirements.kind,
      title: employeeRequirements.title,
      due_date: employeeRequirements.dueDate,
      status: employeeRequirements.status,
      document_key: employeeRequirements.documentKey,
      document_filename: employeeRequirements.documentFilename,
      document_size: employeeRequirements.documentSize,
      document_revision: employeeRequirements.documentRevision,
      invitation_id: employeeRequirements.invitationId,
      invitation_status: invitation.status,
      member_id: employeeRequirements.memberId,
      completed_at: employeeRequirements.completedAt,
      checkr_candidate_id: employeeRequirements.checkrCandidateId,
      checkr_invitation_id: employeeRequirements.checkrInvitationId,
      checkr_report_id: employeeRequirements.checkrReportId,
      checkr_result: employeeRequirements.checkrResult,
      checkr_invitation_status: employeeRequirements.checkrInvitationStatus,
      checkr_starting_at: employeeRequirements.checkrStartingAt,
      checkr_start_nonce: employeeRequirements.checkrStartNonce,
      checkr_start_nonce_at: employeeRequirements.checkrStartNonceAt,
      checkr_start_package: employeeRequirements.checkrStartPackage,
      checkr_attempt: employeeRequirements.checkrAttempt,
      checkr_refresh_revision: employeeRequirements.checkrRefreshRevision,
      target_email: sql<
        string | null
      >`COALESCE(${targetUser.email}, ${invitation.email}, ${employeeRequirements.targetEmail})`,
      target_name: targetUser.name,
    })
    .from(employeeRequirements)
    .leftJoin(member, eq(member.id, employeeRequirements.memberId))
    .leftJoin(targetUser, eq(targetUser.id, member.userId))
    .leftJoin(invitation, eq(invitation.id, employeeRequirements.invitationId))
    .$dynamic();
}

employeeForms.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const manager = canManageOrganization(context.get("organizationRole"));
  const userId = context.get("authSession").user.id;
  const rows = (await selectRequirements(getDb(context.env.DB))
    .where(
      and(
        eq(employeeRequirements.organizationId, organizationId),
        manager ? undefined : eq(member.userId, userId),
      ),
    )
    .orderBy(
      asc(employeeRequirements.dueDate),
      asc(employeeRequirements.createdAt),
    )) as RequirementRow[];
  return context.json({
    requirements: rows.map((row) => toRequirement(row, manager, context.env)),
  });
});

employeeForms.post("/", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body)) {
    return context.json(
      { error: "A target and requirements are required." },
      400,
    );
  }
  const memberId = typeof body.memberId === "string" ? body.memberId : null;
  const invitationId =
    typeof body.invitationId === "string" ? body.invitationId : null;
  if (Boolean(memberId) === Boolean(invitationId)) {
    return context.json({ error: "Choose one member or invitation." }, 400);
  }
  if (
    !Array.isArray(body.requirements) ||
    body.requirements.length < 1 ||
    body.requirements.length > 20 ||
    !body.requirements.every(isRequirementInput)
  ) {
    return context.json({ error: "Choose 1 to 20 valid requirements." }, 400);
  }
  const organizationId = context.get("organizationId");
  const targetId = (memberId ?? invitationId) as string;
  const db = getDb(context.env.DB);
  const target = await findAssignmentTarget(
    db,
    memberId,
    targetId,
    organizationId,
  );
  if (!target) return context.json({ error: "Person not found." }, 404);

  const now = new Date().toISOString();
  const requirements = body.requirements as RequirementInput[];
  const ids = requirements.map(() => crypto.randomUUID());
  const inserted = await db.batch(
    insertRequirements(
      db,
      memberId,
      targetId,
      organizationId,
      requirements.map((requirement, index) => ({
        id: ids[index],
        organizationId,
        invitationId,
        memberId,
        targetEmail: target.email.toLowerCase(),
        assignedUserId: target.user_id,
        kind: requirement.kind,
        title: requirement.title.trim(),
        dueDate: requirement.dueDate,
        createdAt: now,
        updatedAt: now,
      })),
    ),
  );
  if (inserted.some((result) => result.meta.changes !== 1)) {
    return context.json(
      { error: "The invitation or membership changed. Please try again." },
      409,
    );
  }
  return context.json({ ids }, 201);
});

function assignmentTargetWhere(
  memberId: string | null,
  targetId: string,
  organizationId: string,
) {
  return memberId
    ? and(eq(member.id, targetId), eq(member.organizationId, organizationId))
    : and(
        eq(invitation.id, targetId),
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
      );
}

async function findAssignmentTarget(
  db: Db,
  memberId: string | null,
  targetId: string,
  organizationId: string,
): Promise<{ email: string; user_id: string | null } | undefined> {
  const where = assignmentTargetWhere(memberId, targetId, organizationId);
  return memberId
    ? db
        .select({ email: user.email, user_id: user.id })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(where)
        .get()
    : db
        .select({ email: invitation.email, user_id: sql<string | null>`NULL` })
        .from(invitation)
        .where(where)
        .get();
}

type RequirementColumn = keyof typeof employeeRequirements.$inferInsert;

/**
 * One insert per requirement that writes nothing once the member or pending
 * invitation is gone. Drizzle's insert().select() takes every column in table
 * order, so omitted columns select their schema default as values() would.
 */
function insertRequirements(
  db: Db,
  memberId: string | null,
  targetId: string,
  organizationId: string,
  rows: Partial<Record<RequirementColumn, unknown>>[],
) {
  const where = assignmentTargetWhere(memberId, targetId, organizationId);
  const statements = rows.map((values) => {
    const fields = Object.fromEntries(
      Object.entries(getTableColumns(employeeRequirements)).map(
        ([key, column]) => [
          key,
          sql`${key in values ? values[key as RequirementColumn] : (column.default ?? null)}`.as(
            key,
          ),
        ],
      ),
    ) as Record<RequirementColumn, SQL.Aliased>;
    return db
      .insert(employeeRequirements)
      .select(
        memberId
          ? db.select(fields).from(member).where(where)
          : db.select(fields).from(invitation).where(where),
      );
  });
  return statements as [
    (typeof statements)[number],
    ...(typeof statements)[number][],
  ];
}

employeeForms.patch("/:id", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
  const row = await findRequirement(context);
  if (!row) return context.json({ error: "Requirement not found." }, 404);
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body)) return context.json({ error: "Invalid update." }, 400);
  const status = body.status;
  const dueDate = body.dueDate;
  if (!isValidRequirementUpdate(row, body)) {
    return context.json({ error: "Invalid status or due date." }, 400);
  }
  const now = new Date().toISOString();
  const updated = await getDb(context.env.DB)
    .update(employeeRequirements)
    .set({
      status: sql`COALESCE(${status ?? null}, ${employeeRequirements.status})`,
      dueDate: sql`COALESCE(${dueDate ?? null}, ${employeeRequirements.dueDate})`,
      completedAt: sql`CASE
        WHEN ${status ?? null} IS NULL THEN ${employeeRequirements.completedAt}
        WHEN ${status ?? null} = 'complete' THEN ${now}
        ELSE NULL
      END`,
      checkrRefreshRevision: sql`${employeeRequirements.checkrRefreshRevision} +
        CASE WHEN ${status ?? null} IS NOT NULL
          AND ${employeeRequirements.kind} <> 'form' THEN 1 ELSE 0 END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(employeeRequirements.id, row.id),
        eq(employeeRequirements.organizationId, context.get("organizationId")),
        or(
          sql`${status ?? null} IS NULL`,
          ne(employeeRequirements.kind, "form"),
          sql`${employeeRequirements.documentRevision} = ${body.documentRevision ?? null}`,
        ),
        or(
          sql`${status ?? null} IS NULL`,
          isNull(employeeRequirements.checkrInvitationId),
          inArray(
            employeeRequirements.checkrInvitationStatus,
            expiredCheckrStatuses,
          ),
        ),
        or(
          sql`${status ?? null} IS NULL`,
          and(
            isNull(employeeRequirements.checkrStartingAt),
            isNull(employeeRequirements.checkrStartNonce),
          ),
        ),
      ),
    );
  if (!updated.meta.changes) {
    return context.json({ error: "The form changed. Please try again." }, 409);
  }
  return context.json({ ok: true });
});

employeeForms.delete("/:id", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
  const row = await findRequirement(context);
  if (!row) return context.json({ error: "Requirement not found." }, 404);
  if (
    row.checkr_starting_at ||
    row.checkr_start_nonce ||
    (row.checkr_invitation_id && !isExpiredCheckrInvitation(row))
  ) {
    return context.json(
      { error: "A started Checkr screening cannot be removed." },
      409,
    );
  }
  const deleted = await getDb(context.env.DB)
    .delete(employeeRequirements)
    .where(
      and(
        eq(employeeRequirements.id, row.id),
        eq(employeeRequirements.organizationId, context.get("organizationId")),
        isNull(employeeRequirements.checkrStartingAt),
        isNull(employeeRequirements.checkrStartNonce),
        or(
          isNull(employeeRequirements.checkrInvitationId),
          inArray(
            employeeRequirements.checkrInvitationStatus,
            expiredCheckrStatuses,
          ),
        ),
      ),
    );
  if (!deleted.meta.changes) {
    return context.json(
      { error: "Screening is changing. Try again later." },
      409,
    );
  }
  return context.json({ ok: true });
});

employeeForms.post("/:id/document", async (context) => {
  const row = await findRequirement(context);
  if (!row || !(await canAccessRequirement(context, row))) {
    return context.json({ error: "Requirement not found." }, 404);
  }
  if (row.kind !== "form") {
    return context.json({ error: "Only forms accept documents." }, 400);
  }
  const file = await readBoundedDocumentFile(context.req.raw);
  if (file === "too_large") {
    return context.json({ error: "Files must be 10 MB or smaller." }, 413);
  }
  if (!(file instanceof File) || !documentTypes.has(file.type)) {
    return context.json({ error: "Choose a PDF, JPEG, or PNG file." }, 400);
  }
  if (!file.size || file.size > maxDocumentBytes) {
    return context.json({ error: "Files must be 10 MB or smaller." }, 413);
  }
  const key = `organizations/${context.get("organizationId")}/employee-forms/${row.id}/${crypto.randomUUID()}`;
  const filename = normalizeFilename(file.name, "form", 200);
  const db = getDb(context.env.DB);
  await db.insert(deletedObjectCleanup).values({
    id: `employee-form-upload:${crypto.randomUUID()}`,
    organizationId: context.get("organizationId"),
    objectKey: key,
    deletedAt: new Date().toISOString(),
    cleanupToken: null,
    cleanupClaimedAt: null,
  });
  try {
    await context.env.STORAGE.put(key, file, {
      httpMetadata: { contentType: file.type },
    });
    const updated = await linkUploadedDocument(context, row, key, {
      filename,
      size: file.size,
    });
    if (!updated.meta.changes) {
      await context.env.STORAGE.delete(key).catch(console.error);
      return context.json(
        { error: "The form changed. Please try again." },
        409,
      );
    }
  } catch (cause) {
    const linked = await db
      .select({ document_key: employeeRequirements.documentKey })
      .from(employeeRequirements)
      .where(
        and(
          eq(employeeRequirements.id, row.id),
          eq(
            employeeRequirements.organizationId,
            context.get("organizationId"),
          ),
        ),
      )
      .get();
    if (linked?.document_key === key) {
      return context.json({ filename, status: "submitted" });
    }
    await context.env.STORAGE.delete(key).catch(console.error);
    throw cause;
  }
  return context.json({ filename, status: "submitted" });
});

function linkUploadedDocument(
  context: Context<EmployeeFormsEnv>,
  row: RequirementRow,
  key: string,
  document: { filename: string; size: number },
) {
  const db = getDb(context.env.DB);
  return db
    .update(employeeRequirements)
    .set({
      documentKey: key,
      documentFilename: document.filename,
      documentSize: document.size,
      documentRevision: sql`${employeeRequirements.documentRevision} + 1`,
      status: "submitted",
      completedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(employeeRequirements.id, row.id),
        eq(employeeRequirements.organizationId, context.get("organizationId")),
        sql`${employeeRequirements.documentKey} IS ${row.document_key}`,
        exists(
          db
            .select({ one: sql`1` })
            .from(deletedObjectCleanup)
            .where(
              and(
                eq(deletedObjectCleanup.objectKey, key),
                isNull(deletedObjectCleanup.cleanupToken),
              ),
            ),
        ),
        or(
          sql`${canManageOrganization(context.get("organizationRole")) ? 1 : 0} = 1`,
          exists(
            db
              .select({ one: sql`1` })
              .from(member)
              .where(
                and(
                  eq(member.id, employeeRequirements.memberId),
                  eq(member.organizationId, context.get("organizationId")),
                  eq(member.userId, context.get("authSession").user.id),
                ),
              ),
          ),
        ),
      ),
    );
}

async function readBoundedDocumentFile(request: Request) {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data") || !request.body) {
    return null;
  }
  const advertisedLength = Number(request.headers.get("content-length"));
  if (advertisedLength > maxMultipartBytes) return "too_large";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxMultipartBytes) {
        await reader.cancel();
        return "too_large";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const parsed = await new Response(new Blob(chunks), {
    headers: { "Content-Type": contentType },
  })
    .formData()
    .catch(() => null);
  const file = parsed?.get("file");
  return file instanceof File ? file : null;
}

employeeForms.get("/:id/document", async (context) => {
  const row = await findRequirement(context);
  if (
    !row ||
    !(await canAccessRequirement(context, row)) ||
    !row.document_key
  ) {
    return context.json({ error: "Document not found." }, 404);
  }
  const object = await context.env.STORAGE.get(row.document_key);
  if (!object) return context.json({ error: "Document not found." }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Document-Revision", String(row.document_revision));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Disposition",
    `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(row.document_filename ?? "document")}`,
  );
  return new Response(object.body, { headers });
});

employeeForms.post("/:id/checkr/start", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
  const row = await findRequirement(context);
  if (
    !row ||
    row.kind === "form" ||
    !row.target_email ||
    (!row.member_id && !row.invitation_id && !row.checkr_start_nonce) ||
    (row.invitation_id &&
      row.invitation_status !== "pending" &&
      !row.checkr_start_nonce)
  ) {
    return context.json({ error: "Screening requirement not found." }, 404);
  }
  if (row.checkr_invitation_id && !isExpiredCheckrInvitation(row)) {
    return context.json({ error: "Screening already started." }, 409);
  }
  if (
    !checkrConfigured(context.env, row.kind) &&
    !(
      row.checkr_start_nonce &&
      row.checkr_start_package &&
      context.env.CHECKR_API_KEY
    )
  ) {
    return context.json(
      { error: "Checkr is not configured for this screening." },
      503,
    );
  }
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body) || !isUsState(body.state) || !isCity(body.city)) {
    return context.json(
      { error: "A US work state and optional city are required." },
      400,
    );
  }
  const claim = await claimCheckrStart(context, row);
  if (!claim)
    return context.json(
      { error: "Screening is changing. Try again later." },
      409,
    );
  let invitation: Awaited<ReturnType<typeof launchCheckrScreening>>;
  try {
    invitation = await launchCheckrScreening(
      context,
      row,
      claim,
      body.state,
      body.city ?? "",
    );
  } catch (cause) {
    if (cause instanceof CheckrReconciliationRequired) {
      return context.json({ error: cause.message }, 409);
    }
    throw cause;
  }
  if (!invitation)
    return context.json({ error: "Screening could not be resumed." }, 409);
  return context.json({
    invitationId: invitation.id,
    status: invitation.status,
  });
});

employeeForms.post("/:id/checkr/reconcile", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
  const row = await findRequirement(context);
  if (
    !row?.checkr_start_nonce ||
    !row.checkr_candidate_id ||
    !row.checkr_start_package ||
    !context.env.CHECKR_API_KEY
  ) {
    return context.json({ error: "No unresolved Checkr screening." }, 404);
  }
  const body: unknown = await context.req.json().catch(() => null);
  if (
    !isRecord(body) ||
    typeof body.invitationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(body.invitationId)
  ) {
    return context.json({ error: "A Checkr invitation ID is required." }, 400);
  }
  const invitation = await getCheckrInvitation(context.env, body.invitationId);
  const createdAt = invitation.created_at
    ? Date.parse(invitation.created_at)
    : NaN;
  const attemptAt = Date.parse(row.checkr_start_nonce_at ?? "");
  if (
    invitation.id !== body.invitationId ||
    invitation.candidate_id !== row.checkr_candidate_id ||
    invitation.package !== row.checkr_start_package ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(attemptAt) ||
    createdAt < attemptAt - 60_000 ||
    (Array.isArray(invitation.tags) &&
      invitation.tags.length > 0 &&
      !invitation.tags.includes(checkrAttemptTag(row.checkr_start_nonce)))
  ) {
    return context.json(
      { error: "Invitation does not match this screening attempt." },
      409,
    );
  }
  const stored = await storeCheckrInvitation(
    context,
    row,
    row.checkr_start_nonce,
    invitation,
    false,
  );
  if (!stored) {
    return context.json({ error: "Screening changed. Please refresh." }, 409);
  }
  return context.json({ invitationId: stored.id, status: stored.status });
});

employeeForms.post("/:id/checkr/refresh", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
  const row = await findRequirement(context);
  if (!row?.checkr_invitation_id) {
    return context.json({ error: "Screening not started." }, 404);
  }
  const invitation = await getCheckrInvitation(
    context.env,
    row.checkr_invitation_id,
  );
  const invitationStatus = invitation.deleted_at
    ? "deleted"
    : invitation.status;
  const reportId = invitation.report_id ?? row.checkr_report_id;
  const report = reportId ? await getCheckrReport(context.env, reportId) : null;
  const screeningStatus =
    report?.status === "complete" && report.includes_canceled
      ? report.result
        ? "partially_canceled"
        : "canceled"
      : invitationStatus;
  const complete =
    (report?.status === "complete" && !report.includes_canceled) ||
    (row.status === "complete" &&
      isExpiredCheckrStatus(row.checkr_invitation_status));
  const nextStatus = complete
    ? "complete"
    : isExpiredCheckrStatus(screeningStatus)
      ? "pending"
      : "in_progress";
  const now = new Date().toISOString();
  const refreshed = await getDb(context.env.DB)
    .update(employeeRequirements)
    .set({
      checkrInvitationStatus: screeningStatus,
      checkrReportId: reportId,
      checkrResult: report?.result ?? null,
      status: nextStatus,
      completedAt: sql`CASE WHEN ${nextStatus} = 'complete'
        THEN COALESCE(${employeeRequirements.completedAt}, ${now}) ELSE NULL END`,
      updatedAt: now,
      checkrRefreshRevision: sql`${employeeRequirements.checkrRefreshRevision} + 1`,
    })
    .where(
      and(
        eq(employeeRequirements.id, row.id),
        eq(employeeRequirements.organizationId, context.get("organizationId")),
        eq(employeeRequirements.checkrInvitationId, row.checkr_invitation_id),
        eq(
          employeeRequirements.checkrRefreshRevision,
          row.checkr_refresh_revision,
        ),
      ),
    );
  if (!refreshed.meta.changes) {
    return context.json({ error: "Screening changed. Please refresh." }, 409);
  }
  return context.json({
    invitationStatus: screeningStatus,
    reportStatus: report?.status ?? null,
    result: report?.result ?? null,
  });
});

interface CheckrStartClaim {
  checkr_candidate_id: string | null;
  checkr_start_nonce: string;
  checkr_start_nonce_at: string;
  checkr_start_package: string;
}

async function claimCheckrStart(
  context: Context<EmployeeFormsEnv>,
  row: RequirementRow,
) {
  const now = new Date();
  const nonce = crypto.randomUUID();
  const packageSlug =
    checkrPackage(
      context.env,
      row.kind as "background_check" | "credit_check",
    ) || row.checkr_start_package;
  const {
    checkrAttempt,
    checkrInvitationId,
    checkrStartNonce,
    checkrStartNonceAt,
    checkrStartPackage,
    checkrStartingAt,
  } = employeeRequirements;
  return getDb(context.env.DB)
    .update(employeeRequirements)
    .set({
      checkrStartNonce: sql`CASE
        WHEN ${checkrInvitationId} IS NOT NULL THEN ${nonce}
        ELSE COALESCE(${checkrStartNonce}, ${nonce})
      END`,
      checkrStartNonceAt: sql`CASE
        WHEN ${checkrInvitationId} IS NOT NULL OR ${checkrStartNonceAt} IS NULL
          THEN ${now.toISOString()} ELSE ${checkrStartNonceAt}
      END`,
      checkrStartingAt: now.toISOString(),
      checkrStartPackage: sql`CASE
        WHEN ${checkrStartNonce} IS NULL OR ${checkrInvitationId} IS NOT NULL
          THEN ${packageSlug} ELSE COALESCE(${checkrStartPackage}, ${packageSlug}) END`,
      checkrAttempt: sql`CASE WHEN ${checkrInvitationId} IS NOT NULL
        THEN ${checkrAttempt} + 1 ELSE ${checkrAttempt} END`,
      checkrInvitationId: null,
      checkrInvitationStatus: null,
      checkrReportId: null,
      checkrResult: null,
      status: "pending",
      completedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(employeeRequirements.id, row.id),
        eq(employeeRequirements.organizationId, context.get("organizationId")),
        or(
          isNull(checkrInvitationId),
          inArray(
            employeeRequirements.checkrInvitationStatus,
            expiredCheckrStatuses,
          ),
        ),
        or(
          isNull(checkrStartingAt),
          lt(
            checkrStartingAt,
            new Date(now.getTime() - 5 * 60_000).toISOString(),
          ),
        ),
      ),
    )
    .returning({
      checkr_candidate_id: employeeRequirements.checkrCandidateId,
      checkr_start_nonce: checkrStartNonce,
      checkr_start_nonce_at: checkrStartNonceAt,
      checkr_start_package: checkrStartPackage,
    })
    .get() as Promise<CheckrStartClaim | undefined>;
}

async function launchCheckrScreening(
  context: Context<EmployeeFormsEnv>,
  row: RequirementRow,
  claim: CheckrStartClaim,
  state: string,
  city: string,
) {
  let nonce = claim.checkr_start_nonce;
  try {
    if (
      !claim.checkr_candidate_id &&
      !(await screeningTargetActive(context, row.id))
    ) {
      await releaseUnresolvedCheckrStart(context, row.id, nonce, true);
      return null;
    }
    const candidateId =
      claim.checkr_candidate_id ??
      (
        await requestCheckrForStart(context, row.id, nonce, () =>
          createCheckrCandidate(context.env, row.target_email ?? "", row.id),
        )
      ).id;
    if (!candidateId) throw new Error("Checkr did not return a candidate ID.");
    if (!claim.checkr_candidate_id) {
      const stored = await getDb(context.env.DB)
        .update(employeeRequirements)
        .set({
          checkrCandidateId: candidateId,
          updatedAt: new Date().toISOString(),
        })
        .where(checkrStartAttempt(context, row.id, claim.checkr_start_nonce));
      if (!stored.meta.changes) return null;
    }
    if (row.kind === "form") return null;
    const existing = await findPriorCheckrInvitation(
      context,
      row,
      claim,
      candidateId,
    );
    if (existing) {
      return await storeCheckrInvitation(context, row, nonce, existing, false);
    }
    if (!(await screeningTargetActive(context, row.id))) {
      await releaseUnresolvedCheckrStart(
        context,
        row.id,
        nonce,
        new Date(claim.checkr_start_nonce_at).getTime() <
          Date.now() - 5 * 60_000,
      );
      return null;
    }
    const freshNonce = await rotateExpiredCheckrNonce(
      context,
      row.id,
      claim,
      nonce,
    );
    if (!freshNonce) return null;
    nonce = freshNonce;
    const invitation = await requestCheckrForStart(context, row.id, nonce, () =>
      createCheckrInvitation(
        context.env,
        candidateId,
        claim.checkr_start_package,
        state,
        city,
        nonce,
        checkrAttemptTag(nonce),
      ),
    );
    if (!invitation.id)
      throw new Error("Checkr did not return an invitation ID.");
    return await storeCheckrInvitation(context, row, nonce, invitation, true);
  } catch (cause) {
    await getDb(context.env.DB)
      .update(employeeRequirements)
      .set({ checkrStartingAt: null })
      .where(checkrStartAttempt(context, row.id, nonce));
    throw cause;
  }
}

/** Matches the requirement while it still holds this Checkr start attempt. */
function checkrStartAttempt(
  context: Context<EmployeeFormsEnv>,
  requirementId: string,
  nonce: string,
) {
  return and(
    eq(employeeRequirements.id, requirementId),
    eq(employeeRequirements.organizationId, context.get("organizationId")),
    eq(employeeRequirements.checkrStartNonce, nonce),
  );
}

async function requestCheckrForStart<T>(
  context: Context<EmployeeFormsEnv>,
  requirementId: string,
  nonce: string,
  request: () => Promise<T>,
) {
  try {
    return await request();
  } catch (cause) {
    if (isDefinitiveCheckrRejection(cause)) {
      await releaseUnresolvedCheckrStart(context, requirementId, nonce, true);
    }
    throw cause;
  }
}

async function rotateExpiredCheckrNonce(
  context: Context<EmployeeFormsEnv>,
  requirementId: string,
  claim: CheckrStartClaim,
  nonce: string,
) {
  if (
    new Date(claim.checkr_start_nonce_at).getTime() >=
    Date.now() - 23 * 60 * 60_000
  ) {
    return nonce;
  }
  const nextNonce = crypto.randomUUID();
  const rotated = await getDb(context.env.DB)
    .update(employeeRequirements)
    .set({
      checkrStartNonce: nextNonce,
      checkrStartNonceAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        checkrStartAttempt(context, requirementId, nonce),
        isNotNull(employeeRequirements.checkrStartingAt),
      ),
    );
  return rotated.meta.changes ? nextNonce : null;
}

async function screeningTargetActive(
  context: Context<EmployeeFormsEnv>,
  requirementId: string,
) {
  const active = await getDb(context.env.DB)
    .select({ id: employeeRequirements.id })
    .from(employeeRequirements)
    .leftJoin(member, eq(member.id, employeeRequirements.memberId))
    .leftJoin(invitation, eq(invitation.id, employeeRequirements.invitationId))
    .where(
      and(
        eq(employeeRequirements.id, requirementId),
        eq(employeeRequirements.organizationId, context.get("organizationId")),
        or(isNotNull(member.id), eq(invitation.status, "pending")),
      ),
    )
    .get();
  return Boolean(active);
}

async function releaseUnresolvedCheckrStart(
  context: Context<EmployeeFormsEnv>,
  requirementId: string,
  nonce: string,
  clearNonce: boolean,
) {
  await getDb(context.env.DB)
    .update(employeeRequirements)
    .set({
      checkrStartingAt: null,
      checkrStartNonce: sql`CASE WHEN ${clearNonce ? 1 : 0} = 1
        THEN NULL ELSE ${employeeRequirements.checkrStartNonce} END`,
      checkrStartNonceAt: sql`CASE WHEN ${clearNonce ? 1 : 0} = 1
        THEN NULL ELSE ${employeeRequirements.checkrStartNonceAt} END`,
      updatedAt: new Date().toISOString(),
    })
    .where(checkrStartAttempt(context, requirementId, nonce));
}

async function findPriorCheckrInvitation(
  context: Context<EmployeeFormsEnv>,
  row: RequirementRow,
  claim: CheckrStartClaim,
  candidateId: string,
) {
  if (!row.checkr_start_nonce || !claim.checkr_candidate_id) return null;
  const invitations = await listCheckrCandidateInvitations(
    context.env,
    candidateId,
  );
  const attemptAt = Date.parse(claim.checkr_start_nonce_at);
  const active = invitations.data.filter((invitation) => {
    const invitationAt = Date.parse(invitation.created_at ?? "");
    return (
      !isExpiredCheckrStatus(invitation.status) &&
      (invitation.package === claim.checkr_start_package ||
        invitation.package === undefined) &&
      (!Number.isFinite(invitationAt) ||
        !Number.isFinite(attemptAt) ||
        invitationAt >= attemptAt - 60_000)
    );
  });
  const matched = active.filter((invitation) =>
    invitation.tags?.includes(checkrAttemptTag(claim.checkr_start_nonce)),
  );
  if (matched.length > 1) {
    throw new CheckrReconciliationRequired();
  }
  if (matched[0]) return matched[0];
  const ambiguous = active.some(
    (invitation) =>
      invitation.package === undefined ||
      !Array.isArray(invitation.tags) ||
      invitation.tags.length === 0,
  );
  if (ambiguous) {
    const nonceStillIdempotent =
      new Date(claim.checkr_start_nonce_at).getTime() >=
      Date.now() - 23 * 60 * 60_000;
    if (
      !nonceStillIdempotent ||
      !(await screeningTargetActive(context, row.id))
    ) {
      throw new CheckrReconciliationRequired();
    }
    return null;
  }
  if (invitations.data.length >= 100) {
    throw new CheckrReconciliationRequired();
  }
  return null;
}

class CheckrReconciliationRequired extends Error {
  constructor() {
    super("Checkr invitations need manual reconciliation before retrying.");
  }
}

function checkrAttemptTag(nonce: string) {
  return `tearleads-screening:${nonce}`;
}

async function storeCheckrInvitation(
  context: Context<EmployeeFormsEnv>,
  row: RequirementRow,
  nonce: string,
  invitation: Awaited<ReturnType<typeof createCheckrInvitation>>,
  cancelIfOrphaned: boolean,
) {
  const stored = await getDb(context.env.DB)
    .update(employeeRequirements)
    .set({
      checkrInvitationId: invitation.id,
      checkrInvitationStatus: invitation.status,
      checkrReportId: invitation.report_id,
      status: isExpiredCheckrStatus(invitation.status)
        ? "pending"
        : "in_progress",
      checkrStartingAt: null,
      checkrStartNonce: null,
      checkrStartNonceAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(checkrStartAttempt(context, row.id, nonce));
  if (stored.meta.changes) return invitation;
  const current = await findRequirement(context);
  if (current?.checkr_invitation_id === invitation.id) return invitation;
  if (cancelIfOrphaned) {
    try {
      await cancelCheckrInvitation(context.env, invitation.id);
    } catch (cause) {
      console.error(
        "Could not cancel a screening whose requirement disappeared.",
        cause,
      );
    }
  }
  return null;
}

export async function assignAcceptedInvitationRequirements(
  database: D1Database,
  organizationId: string,
  invitationId: string,
  memberId: string,
) {
  const db = getDb(database);
  await db
    .update(employeeRequirements)
    .set({
      invitationId: null,
      memberId,
      assignedUserId: sql`${db
        .select({ userId: member.userId })
        .from(member)
        .where(eq(member.id, memberId))}`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(employeeRequirements.organizationId, organizationId),
        eq(employeeRequirements.invitationId, invitationId),
      ),
    );
}

export async function assignRenewedInvitationRequirements(
  database: D1Database,
  organizationId: string,
  invitationId: string,
  email: string,
) {
  const db = getDb(database);
  const old = alias(invitation, "old");
  await db
    .update(employeeRequirements)
    .set({ invitationId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(employeeRequirements.organizationId, organizationId),
        isNull(employeeRequirements.memberId),
        isNull(employeeRequirements.assignedUserId),
        sql`${employeeRequirements.targetEmail} = ${email} COLLATE NOCASE`,
        or(
          isNull(employeeRequirements.invitationId),
          exists(
            db
              .select({ one: sql`1` })
              .from(old)
              .where(
                and(
                  eq(old.id, employeeRequirements.invitationId),
                  or(
                    ne(old.status, "pending"),
                    lte(old.expiresAt, new Date().toISOString()),
                  ),
                ),
              ),
          ),
        ),
      ),
    );
}

function toRequirement(row: RequirementRow, manager: boolean, env: Bindings) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    dueDate: row.due_date,
    status: row.status,
    hasDocument: Boolean(row.document_key),
    documentFilename: row.document_filename,
    documentSize: row.document_size,
    documentRevision: row.document_revision,
    invitationId: row.invitation_id,
    invitationStatus: row.invitation_status,
    memberId: row.member_id,
    targetEmail: row.target_email,
    targetName: row.target_name,
    completedAt: row.completed_at,
    checkrAvailable:
      row.kind !== "form" &&
      Boolean(row.member_id || row.invitation_id || row.checkr_start_nonce) &&
      (!row.invitation_id ||
        row.invitation_status === "pending" ||
        Boolean(row.checkr_start_nonce)) &&
      checkrConfigured(env, row.kind),
    checkrStarted:
      Boolean(row.checkr_invitation_id) && !isExpiredCheckrInvitation(row),
    checkrPendingStart: Boolean(row.checkr_start_nonce),
    checkrInvitationStatus: row.checkr_invitation_status,
    checkrResult: manager ? row.checkr_result : null,
  };
}

interface InputRecord {
  memberId?: unknown;
  invitationId?: unknown;
  requirements?: unknown;
  status?: unknown;
  dueDate?: unknown;
  file?: unknown;
  documentRevision?: unknown;
  kind?: unknown;
  title?: unknown;
  state?: unknown;
  city?: unknown;
}

function isRecord(value: unknown): value is InputRecord {
  return typeof value === "object" && value !== null;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isRequirementInput(value: unknown): value is RequirementInput {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    ["form", "background_check", "credit_check"].includes(value.kind) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    value.title.trim().length <= 100 &&
    isDate(value.dueDate)
  );
}

function isStatus(value: unknown): value is RequirementStatus {
  return (
    typeof value === "string" &&
    ["pending", "in_progress", "submitted", "complete"].includes(value)
  );
}

function isValidRequirementUpdate(row: RequirementRow, body: InputRecord) {
  const { status, dueDate, documentRevision } = body;
  return !(
    (status !== undefined && !isStatus(status)) ||
    (dueDate !== undefined && !isDate(dueDate)) ||
    (documentRevision !== undefined &&
      (!Number.isSafeInteger(documentRevision) ||
        Number(documentRevision) < 0)) ||
    (status === undefined && dueDate === undefined) ||
    (row.kind === "form" && status === "in_progress") ||
    (row.kind !== "form" && status === "submitted") ||
    (row.kind === "form" && status === "complete" && !row.document_key) ||
    (row.kind === "form" &&
      status !== undefined &&
      documentRevision === undefined) ||
    (row.checkr_invitation_id &&
      !isExpiredCheckrInvitation(row) &&
      status !== undefined) ||
    (status !== undefined &&
      (row.checkr_starting_at !== null || row.checkr_start_nonce !== null))
  );
}

function isExpiredCheckrStatus(status: string | null) {
  return (
    status === "expired" ||
    status === "canceled" ||
    status === "deleted" ||
    status === "partially_canceled"
  );
}

function isExpiredCheckrInvitation(row: RequirementRow) {
  return isExpiredCheckrStatus(row.checkr_invitation_status);
}

function isUsState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value);
}

function isCity(value: unknown): value is string | undefined {
  return (
    value === undefined || (typeof value === "string" && value.length <= 100)
  );
}

async function findRequirement(context: Context<EmployeeFormsEnv>) {
  return selectRequirements(getDb(context.env.DB))
    .where(
      and(
        eq(employeeRequirements.id, context.req.param("id") as string),
        eq(employeeRequirements.organizationId, context.get("organizationId")),
      ),
    )
    .get() as Promise<RequirementRow | undefined>;
}

async function canAccessRequirement(
  context: Context<EmployeeFormsEnv>,
  row: RequirementRow,
) {
  if (canManageOrganization(context.get("organizationRole"))) return true;
  if (!row.member_id) return false;
  const membership = await getDb(context.env.DB)
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.id, row.member_id),
        eq(member.organizationId, context.get("organizationId")),
        eq(member.userId, context.get("authSession").user.id),
      ),
    )
    .get();
  return Boolean(membership);
}

function managerRequired(context: Context<EmployeeFormsEnv>) {
  return context.json({ error: "Organization manager access required." }, 403);
}

export { employeeForms };
