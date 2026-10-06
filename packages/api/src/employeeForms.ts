import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import {
  CheckrRequestError,
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
import { normalizeFilename } from "./filenames";
import { canManageOrganization } from "./organizationMembers";
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

employeeForms.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const manager = canManageOrganization(context.get("organizationRole"));
  const userId = context.get("authSession").user.id;
  const result = await context.env.DB.prepare(
    `SELECT requirement.id, requirement.kind, requirement.title,
            requirement.due_date, requirement.status, requirement.document_key,
            requirement.document_filename, requirement.document_size,
            requirement.document_revision,
            requirement.invitation_id, invitation.status AS invitation_status,
            requirement.member_id,
            requirement.completed_at, requirement.checkr_candidate_id,
            requirement.checkr_invitation_id, requirement.checkr_report_id,
            requirement.checkr_result, requirement.checkr_invitation_status,
            requirement.checkr_starting_at, requirement.checkr_start_nonce,
            requirement.checkr_start_nonce_at, requirement.checkr_attempt,
            requirement.checkr_start_package,
            requirement.checkr_refresh_revision,
            COALESCE(target.email, invitation.email, requirement.target_email)
              AS target_email,
            target.name AS target_name
     FROM employee_requirements AS requirement
     LEFT JOIN member ON member.id = requirement.member_id
     LEFT JOIN user AS target ON target.id = member.userId
     LEFT JOIN invitation ON invitation.id = requirement.invitation_id
     WHERE requirement.organization_id = ?
       AND (${manager ? "1 = 1" : "member.userId = ?"})
     ORDER BY requirement.due_date ASC, requirement.created_at ASC`,
  )
    .bind(...(manager ? [organizationId] : [organizationId, userId]))
    .all<RequirementRow>();
  return context.json({
    requirements: result.results.map((row) =>
      toRequirement(row, manager, context.env),
    ),
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
  const target = await context.env.DB.prepare(
    memberId
      ? `SELECT user.email, user.id AS user_id
         FROM member JOIN user ON user.id = member.userId
         WHERE member.id = ? AND member.organizationId = ?`
      : `SELECT email, NULL AS user_id FROM invitation
         WHERE id = ? AND organizationId = ? AND status = 'pending'`,
  )
    .bind(memberId ?? invitationId, organizationId)
    .first<{ email: string; user_id: string | null }>();
  if (!target) return context.json({ error: "Person not found." }, 404);

  const now = new Date().toISOString();
  const requirements = body.requirements as RequirementInput[];
  const ids = requirements.map(() => crypto.randomUUID());
  const inserted = await context.env.DB.batch(
    requirements.map((requirement, index) =>
      context.env.DB.prepare(
        `INSERT INTO employee_requirements
         (id, organization_id, invitation_id, member_id, target_email,
          assigned_user_id,
          kind, title, due_date, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM ${memberId ? "member" : "invitation"}
           WHERE id = ? AND organizationId = ?
             ${memberId ? "" : "AND status = 'pending'"}
         )`,
      ).bind(
        ids[index],
        organizationId,
        invitationId,
        memberId,
        target.email.toLowerCase(),
        target.user_id,
        requirement.kind,
        requirement.title.trim(),
        requirement.dueDate,
        now,
        now,
        memberId ?? invitationId,
        organizationId,
      ),
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
  const updated = await context.env.DB.prepare(
    `UPDATE employee_requirements
     SET status = COALESCE(?, status), due_date = COALESCE(?, due_date),
         completed_at = CASE
           WHEN ? IS NULL THEN completed_at
           WHEN ? = 'complete' THEN ?
           ELSE NULL
         END,
         checkr_refresh_revision = checkr_refresh_revision +
           CASE WHEN ? IS NOT NULL AND kind <> 'form' THEN 1 ELSE 0 END,
         updated_at = ?
     WHERE id = ? AND organization_id = ?
       AND (? IS NULL OR kind <> 'form' OR document_revision = ?)
       AND (? IS NULL OR checkr_invitation_id IS NULL OR
            checkr_invitation_status IN
              ('expired', 'canceled', 'deleted', 'partially_canceled'))
       AND (? IS NULL OR
            (checkr_starting_at IS NULL AND checkr_start_nonce IS NULL))`,
  )
    .bind(
      status ?? null,
      dueDate ?? null,
      status ?? null,
      status ?? null,
      now,
      status ?? null,
      now,
      row.id,
      context.get("organizationId"),
      status ?? null,
      body.documentRevision ?? null,
      status ?? null,
      status ?? null,
    )
    .run();
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
  const deleted = await context.env.DB.prepare(
    `DELETE FROM employee_requirements
     WHERE id = ? AND organization_id = ? AND checkr_starting_at IS NULL
       AND checkr_start_nonce IS NULL
       AND (checkr_invitation_id IS NULL OR
            checkr_invitation_status IN
              ('expired', 'canceled', 'deleted', 'partially_canceled'))`,
  )
    .bind(row.id, context.get("organizationId"))
    .run();
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
  await context.env.DB.prepare(
    `INSERT INTO deleted_object_cleanup
       (id, organization_id, object_key, deleted_at, cleanup_token,
        cleanup_claimed_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      `employee-form-upload:${crypto.randomUUID()}`,
      context.get("organizationId"),
      key,
      new Date().toISOString(),
    )
    .run();
  try {
    await context.env.STORAGE.put(key, file, {
      httpMetadata: { contentType: file.type },
    });
    const updated = await context.env.DB.prepare(
      `UPDATE employee_requirements
       SET document_key = ?, document_filename = ?, document_size = ?,
           document_revision = document_revision + 1,
           status = 'submitted', completed_at = NULL, updated_at = ?
       WHERE id = ? AND organization_id = ? AND document_key IS ?
         AND EXISTS (
           SELECT 1 FROM deleted_object_cleanup
           WHERE object_key = ? AND cleanup_token IS NULL
         )
         AND (? = 1 OR EXISTS (
           SELECT 1 FROM member WHERE member.id = employee_requirements.member_id
             AND member.organizationId = ? AND member.userId = ?
         ))`,
    )
      .bind(
        key,
        filename,
        file.size,
        new Date().toISOString(),
        row.id,
        context.get("organizationId"),
        row.document_key,
        key,
        canManageOrganization(context.get("organizationRole")) ? 1 : 0,
        context.get("organizationId"),
        context.get("authSession").user.id,
      )
      .run();
    if (!updated.meta.changes) {
      await context.env.STORAGE.delete(key).catch(console.error);
      return context.json(
        { error: "The form changed. Please try again." },
        409,
      );
    }
  } catch (cause) {
    const linked = await context.env.DB.prepare(
      `SELECT document_key FROM employee_requirements
       WHERE id = ? AND organization_id = ?`,
    )
      .bind(row.id, context.get("organizationId"))
      .first<{ document_key: string | null }>();
    if (linked?.document_key === key) {
      return context.json({ filename, status: "submitted" });
    }
    await context.env.STORAGE.delete(key).catch(console.error);
    throw cause;
  }
  return context.json({ filename, status: "submitted" });
});

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
  const refreshed = await context.env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_invitation_status = ?, checkr_report_id = ?,
         checkr_result = ?, status = ?,
         completed_at = CASE WHEN ? = 'complete'
           THEN COALESCE(completed_at, ?) ELSE NULL END,
         updated_at = ?,
         checkr_refresh_revision = checkr_refresh_revision + 1
     WHERE id = ? AND organization_id = ? AND checkr_invitation_id = ?
       AND checkr_refresh_revision = ?`,
  )
    .bind(
      screeningStatus,
      reportId,
      report?.result ?? null,
      nextStatus,
      nextStatus,
      now,
      now,
      row.id,
      context.get("organizationId"),
      row.checkr_invitation_id,
      row.checkr_refresh_revision,
    )
    .run();
  if (!refreshed.meta.changes) {
    return context.json({ error: "Screening changed. Please refresh." }, 409);
  }
  return context.json({
    invitationStatus: screeningStatus,
    reportStatus: report?.status ?? null,
    result: report?.result ?? null,
  });
});

employeeForms.onError((error, context) => {
  console.error(error);
  if (error instanceof CheckrRequestError) {
    return context.json({ error: error.message }, 502);
  }
  return context.json({ error: "Unexpected server error." }, 500);
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
  return context.env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_start_nonce = CASE
           WHEN checkr_invitation_id IS NOT NULL THEN ?
           ELSE COALESCE(checkr_start_nonce, ?)
         END,
         checkr_start_nonce_at = CASE
           WHEN checkr_invitation_id IS NOT NULL OR checkr_start_nonce_at IS NULL
             THEN ? ELSE checkr_start_nonce_at
         END,
         checkr_starting_at = ?,
         checkr_start_package = CASE
           WHEN checkr_start_nonce IS NULL OR checkr_invitation_id IS NOT NULL
             THEN ? ELSE COALESCE(checkr_start_package, ?) END,
         checkr_attempt = CASE WHEN checkr_invitation_id IS NOT NULL
           THEN checkr_attempt + 1 ELSE checkr_attempt END,
         checkr_invitation_id = NULL, checkr_invitation_status = NULL,
         checkr_report_id = NULL, checkr_result = NULL,
         status = 'pending', completed_at = NULL, updated_at = ?
     WHERE id = ? AND organization_id = ?
       AND (checkr_invitation_id IS NULL OR
            checkr_invitation_status IN
              ('expired', 'canceled', 'deleted', 'partially_canceled'))
       AND (checkr_starting_at IS NULL OR checkr_starting_at < ?)
     RETURNING checkr_candidate_id, checkr_start_nonce,
               checkr_start_nonce_at, checkr_start_package`,
  )
    .bind(
      nonce,
      nonce,
      now.toISOString(),
      now.toISOString(),
      packageSlug,
      packageSlug,
      now.toISOString(),
      row.id,
      context.get("organizationId"),
      new Date(now.getTime() - 5 * 60_000).toISOString(),
    )
    .first<CheckrStartClaim>();
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
      const stored = await context.env.DB.prepare(
        `UPDATE employee_requirements
         SET checkr_candidate_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?`,
      )
        .bind(
          candidateId,
          new Date().toISOString(),
          row.id,
          context.get("organizationId"),
          claim.checkr_start_nonce,
        )
        .run();
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
    await context.env.DB.prepare(
      `UPDATE employee_requirements SET checkr_starting_at = NULL
       WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?`,
    )
      .bind(row.id, context.get("organizationId"), nonce)
      .run();
    throw cause;
  }
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
  const rotated = await context.env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_start_nonce = ?, checkr_start_nonce_at = ?, updated_at = ?
     WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?
       AND checkr_starting_at IS NOT NULL`,
  )
    .bind(
      nextNonce,
      new Date().toISOString(),
      new Date().toISOString(),
      requirementId,
      context.get("organizationId"),
      nonce,
    )
    .run();
  return rotated.meta.changes ? nextNonce : null;
}

async function screeningTargetActive(
  context: Context<EmployeeFormsEnv>,
  requirementId: string,
) {
  const active = await context.env.DB.prepare(
    `SELECT requirement.id FROM employee_requirements AS requirement
     LEFT JOIN member ON member.id = requirement.member_id
     LEFT JOIN invitation ON invitation.id = requirement.invitation_id
     WHERE requirement.id = ? AND requirement.organization_id = ?
       AND (member.id IS NOT NULL OR invitation.status = 'pending')`,
  )
    .bind(requirementId, context.get("organizationId"))
    .first<{ id: string }>();
  return Boolean(active);
}

async function releaseUnresolvedCheckrStart(
  context: Context<EmployeeFormsEnv>,
  requirementId: string,
  nonce: string,
  clearNonce: boolean,
) {
  await context.env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_starting_at = NULL,
         checkr_start_nonce = CASE WHEN ? = 1 THEN NULL ELSE checkr_start_nonce END,
         checkr_start_nonce_at = CASE WHEN ? = 1 THEN NULL ELSE checkr_start_nonce_at END,
         updated_at = ?
     WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?`,
  )
    .bind(
      clearNonce ? 1 : 0,
      clearNonce ? 1 : 0,
      new Date().toISOString(),
      requirementId,
      context.get("organizationId"),
      nonce,
    )
    .run();
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
  const stored = await context.env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_invitation_id = ?, checkr_invitation_status = ?,
         checkr_report_id = ?, status = ?,
         checkr_starting_at = NULL, checkr_start_nonce = NULL,
         checkr_start_nonce_at = NULL, updated_at = ?
     WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?`,
  )
    .bind(
      invitation.id,
      invitation.status,
      invitation.report_id,
      isExpiredCheckrStatus(invitation.status) ? "pending" : "in_progress",
      new Date().toISOString(),
      row.id,
      context.get("organizationId"),
      nonce,
    )
    .run();
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
  const statement = database.prepare(
    `UPDATE employee_requirements
     SET invitation_id = NULL, member_id = ?,
         assigned_user_id = (SELECT userId FROM member WHERE id = ?),
         updated_at = ?
     WHERE organization_id = ? AND invitation_id = ?`,
  );
  const values = [
    memberId,
    memberId,
    new Date().toISOString(),
    organizationId,
    invitationId,
  ];
  if (typeof statement.bind === "function") {
    await statement.bind(...values).run();
  } else {
    await (
      statement as unknown as { run: (...values: string[]) => unknown }
    ).run(...values);
  }
}

export async function assignRenewedInvitationRequirements(
  database: D1Database,
  organizationId: string,
  invitationId: string,
  email: string,
) {
  const statement = database.prepare(
    `UPDATE employee_requirements
     SET invitation_id = ?, updated_at = ?
     WHERE organization_id = ? AND member_id IS NULL
       AND assigned_user_id IS NULL
       AND target_email = ? COLLATE NOCASE
       AND (invitation_id IS NULL OR EXISTS (
         SELECT 1 FROM invitation AS old
         WHERE old.id = employee_requirements.invitation_id
           AND (old.status <> 'pending' OR old.expiresAt <= ?)
       ))`,
  );
  const values = [
    invitationId,
    new Date().toISOString(),
    organizationId,
    email,
    new Date().toISOString(),
  ];
  if (typeof statement.bind === "function") {
    await statement.bind(...values).run();
  } else {
    await (
      statement as unknown as { run: (...values: string[]) => unknown }
    ).run(...values);
  }
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
  return context.env.DB.prepare(
    `SELECT requirement.id, requirement.kind, requirement.title,
            requirement.due_date, requirement.status, requirement.document_key,
            document_filename, document_size, document_revision,
            invitation_id,
            invitation.status AS invitation_status, member_id,
            completed_at, checkr_candidate_id, checkr_invitation_id,
            checkr_report_id, checkr_result, checkr_invitation_status,
            checkr_starting_at, checkr_start_nonce,
            checkr_start_nonce_at, checkr_start_package,
            checkr_attempt, checkr_refresh_revision,
            COALESCE(target.email, invitation.email, requirement.target_email)
              AS target_email,
            target.name AS target_name
     FROM employee_requirements AS requirement
     LEFT JOIN member ON member.id = requirement.member_id
     LEFT JOIN user AS target ON target.id = member.userId
     LEFT JOIN invitation ON invitation.id = requirement.invitation_id
     WHERE requirement.id = ? AND requirement.organization_id = ?`,
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .first<RequirementRow>();
}

async function canAccessRequirement(
  context: Context<EmployeeFormsEnv>,
  row: RequirementRow,
) {
  if (canManageOrganization(context.get("organizationRole"))) return true;
  if (!row.member_id) return false;
  const member = await context.env.DB.prepare(
    `SELECT id FROM member WHERE id = ? AND organizationId = ? AND userId = ?`,
  )
    .bind(
      row.member_id,
      context.get("organizationId"),
      context.get("authSession").user.id,
    )
    .first<{ id: string }>();
  return Boolean(member);
}

function managerRequired(context: Context<EmployeeFormsEnv>) {
  return context.json({ error: "Organization manager access required." }, 403);
}

export { employeeForms };
