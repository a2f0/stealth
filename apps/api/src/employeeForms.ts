import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import {
  checkrConfigured,
  checkrPackage,
  createCheckrCandidate,
  createCheckrInvitation,
  getCheckrInvitation,
  getCheckrReport,
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
}

type EmployeeFormsEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
const employeeForms = new Hono<EmployeeFormsEnv>();
const maxDocumentBytes = 10 * 1024 * 1024;
const documentTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

employeeForms.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const manager = canManageOrganization(context.get("organizationRole"));
  const userId = context.get("authSession").user.id;
  const result = await context.env.DB.prepare(
    `SELECT requirement.id, requirement.kind, requirement.title,
            requirement.due_date, requirement.status, requirement.document_key,
            requirement.document_filename, requirement.document_size,
            requirement.invitation_id, invitation.status AS invitation_status,
            requirement.member_id,
            requirement.completed_at, requirement.checkr_candidate_id,
            requirement.checkr_invitation_id, requirement.checkr_report_id,
            requirement.checkr_result, requirement.checkr_invitation_status,
            COALESCE(target.email, invitation.email) AS target_email,
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
      ? `SELECT id FROM member WHERE id = ? AND organizationId = ?`
      : `SELECT id FROM invitation
         WHERE id = ? AND organizationId = ? AND status = 'pending'`,
  )
    .bind(memberId ?? invitationId, organizationId)
    .first<{ id: string }>();
  if (!target) return context.json({ error: "Person not found." }, 404);

  const now = new Date().toISOString();
  const requirements = body.requirements as RequirementInput[];
  const ids = requirements.map(() => crypto.randomUUID());
  const inserted = await context.env.DB.batch(
    requirements.map((requirement, index) =>
      context.env.DB.prepare(
        `INSERT INTO employee_requirements
         (id, organization_id, invitation_id, member_id, kind, title,
          due_date, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
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
  if (
    (status !== undefined && !isStatus(status)) ||
    (dueDate !== undefined && !isDate(dueDate)) ||
    (status === undefined && dueDate === undefined) ||
    (row.kind === "form" && status === "in_progress") ||
    (row.kind !== "form" && status === "submitted") ||
    (row.kind === "form" && status === "complete" && !row.document_key) ||
    (row.checkr_invitation_id && status !== undefined)
  ) {
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
         updated_at = ?
     WHERE id = ? AND organization_id = ?
       AND (? IS NULL OR kind <> 'form' OR document_key IS ?)`,
  )
    .bind(
      status ?? null,
      dueDate ?? null,
      status ?? null,
      status ?? null,
      now,
      now,
      row.id,
      context.get("organizationId"),
      status ?? null,
      row.document_key,
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
  if (row.checkr_invitation_id) {
    return context.json(
      { error: "A started Checkr screening cannot be removed." },
      409,
    );
  }
  await context.env.DB.prepare(
    `DELETE FROM employee_requirements WHERE id = ? AND organization_id = ?`,
  )
    .bind(row.id, context.get("organizationId"))
    .run();
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
  const body = (await context.req.parseBody()) as { file?: File | string };
  const file = body.file;
  if (!(file instanceof File) || !documentTypes.has(file.type)) {
    return context.json({ error: "Choose a PDF, JPEG, or PNG file." }, 400);
  }
  if (!file.size || file.size > maxDocumentBytes) {
    return context.json({ error: "Files must be 10 MB or smaller." }, 413);
  }
  const key = `organizations/${context.get("organizationId")}/employee-forms/${row.id}/${crypto.randomUUID()}`;
  const filename = normalizeFilename(file.name, "form", 200);
  await context.env.STORAGE.put(key, file, {
    httpMetadata: { contentType: file.type },
  });
  try {
    const updated = await context.env.DB.prepare(
      `UPDATE employee_requirements
       SET document_key = ?, document_filename = ?, document_size = ?,
           status = 'submitted', completed_at = NULL, updated_at = ?
       WHERE id = ? AND organization_id = ? AND document_key IS ?`,
    )
      .bind(
        key,
        filename,
        file.size,
        new Date().toISOString(),
        row.id,
        context.get("organizationId"),
        row.document_key,
      )
      .run();
    if (!updated.meta.changes) {
      await context.env.STORAGE.delete(key);
      return context.json(
        { error: "The form changed. Please try again." },
        409,
      );
    }
  } catch (cause) {
    await context.env.STORAGE.delete(key);
    throw cause;
  }
  return context.json({ filename, status: "submitted" });
});

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
    (row.invitation_id && row.invitation_status !== "pending")
  ) {
    return context.json({ error: "Screening requirement not found." }, 404);
  }
  if (row.checkr_invitation_id) {
    return context.json({ error: "Screening already started." }, 409);
  }
  if (!checkrConfigured(context.env, row.kind)) {
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
  const candidateId =
    row.checkr_candidate_id ??
    (await createCheckrCandidate(context.env, row.target_email, row.id)).id;
  if (!candidateId) throw new Error("Checkr did not return a candidate ID.");
  if (!row.checkr_candidate_id) {
    await context.env.DB.prepare(
      `UPDATE employee_requirements SET checkr_candidate_id = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND checkr_candidate_id IS NULL`,
    )
      .bind(
        candidateId,
        new Date().toISOString(),
        row.id,
        context.get("organizationId"),
      )
      .run();
  }
  const invitation = await createCheckrInvitation(
    context.env,
    candidateId,
    checkrPackage(context.env, row.kind) ?? "",
    body.state,
    body.city ?? "",
    row.id,
  );
  if (!invitation.id)
    throw new Error("Checkr did not return an invitation ID.");
  const updated = await context.env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_invitation_id = ?, checkr_invitation_status = ?,
         checkr_report_id = ?, status = 'in_progress', updated_at = ?
     WHERE id = ? AND organization_id = ? AND checkr_invitation_id IS NULL`,
  )
    .bind(
      invitation.id,
      invitation.status,
      invitation.report_id,
      new Date().toISOString(),
      row.id,
      context.get("organizationId"),
    )
    .run();
  if (!updated.meta.changes) {
    return context.json({ error: "Screening already started." }, 409);
  }
  return context.json({
    invitationId: invitation.id,
    status: invitation.status,
  });
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
  const reportId = invitation.report_id ?? row.checkr_report_id;
  const report = reportId ? await getCheckrReport(context.env, reportId) : null;
  const complete = report?.status === "complete";
  await context.env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_invitation_status = ?, checkr_report_id = ?,
         checkr_result = ?, status = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(
      invitation.status,
      reportId,
      report?.result ?? null,
      complete ? "complete" : "in_progress",
      complete ? new Date().toISOString() : null,
      new Date().toISOString(),
      row.id,
      context.get("organizationId"),
    )
    .run();
  return context.json({
    invitationStatus: invitation.status,
    reportStatus: report?.status ?? null,
    result: report?.result ?? null,
  });
});

export async function assignAcceptedInvitationRequirements(
  database: D1Database,
  organizationId: string,
  invitationId: string,
  memberId: string,
) {
  const statement = database.prepare(
    `UPDATE employee_requirements
     SET invitation_id = NULL, member_id = ?, updated_at = ?
     WHERE organization_id = ? AND invitation_id = ?`,
  );
  const values = [
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
    invitationId: row.invitation_id,
    invitationStatus: row.invitation_status,
    memberId: row.member_id,
    targetEmail: row.target_email,
    targetName: row.target_name,
    completedAt: row.completed_at,
    checkrAvailable:
      row.kind !== "form" &&
      (!row.invitation_id || row.invitation_status === "pending") &&
      checkrConfigured(env, row.kind),
    checkrStarted: Boolean(row.checkr_invitation_id),
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
            document_filename, document_size, invitation_id,
            invitation.status AS invitation_status, member_id,
            completed_at, checkr_candidate_id, checkr_invitation_id,
            checkr_report_id, checkr_result, checkr_invitation_status,
            COALESCE(target.email, invitation.email) AS target_email,
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
