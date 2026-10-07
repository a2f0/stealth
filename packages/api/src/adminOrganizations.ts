import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import {
  cancelOrganizationSubscription,
  recoverCheckoutAfterFailedDeletion,
} from "./billing";
import {
  markOrganizationForDeletion,
  restoreOrganization,
} from "./organizationDeletion";
import { listOrganizationMembers } from "./organizationMembers";
import type { Bindings } from "./types";

const adminOrganizations = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

interface OrganizationRow {
  created_at: number | string;
  deleted_by_email: string | null;
  deleted_by_name: string | null;
  deleted_by_user_id: string | null;
  deleted_at: number | string | null;
  id: string;
  member_count: number;
  name: string;
  owner_email: string | null;
  owner_name: string | null;
  slug: string;
}

const organizationQuery = `SELECT organization.id, organization.name, organization.slug,
            organization.createdAt AS created_at,
            organization.deletedAt AS deleted_at,
            organization.deletedByUserId AS deleted_by_user_id,
            deleted_by.name AS deleted_by_name,
            deleted_by.email AS deleted_by_email,
            owner.name AS owner_name, owner.email AS owner_email,
            COUNT(member.id) AS member_count
     FROM organization
     LEFT JOIN user AS owner
       ON owner.defaultOrganizationId = organization.id
     LEFT JOIN user AS deleted_by
       ON deleted_by.id = organization.deletedByUserId
     LEFT JOIN member ON member.organizationId = organization.id`;

adminOrganizations.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `${organizationQuery}
     GROUP BY organization.id
     ORDER BY organization.createdAt DESC
     LIMIT 100`,
  ).all<OrganizationRow>();

  return context.json({
    organizations: result.results.map(toAdminOrganization),
  });
});

adminOrganizations.get("/:organizationId", async (context) => {
  const organizationId = context.req.param("organizationId");
  const organization = await context.env.DB.prepare(
    `${organizationQuery} WHERE organization.id = ? GROUP BY organization.id`,
  )
    .bind(organizationId)
    .first<OrganizationRow>();
  if (!organization) {
    return context.json({ error: "Organization not found." }, 404);
  }
  const [members, requirements] = await Promise.all([
    listOrganizationMembers(context.env.DB, organizationId),
    listAdminRequirements(context.env, organizationId),
  ]);
  return context.json({
    organization: toAdminOrganization(organization),
    members,
    requirements,
  });
});

function toAdminOrganization(organization: OrganizationRow) {
  return {
    createdAt: organization.created_at,
    deletedByEmail: organization.deleted_by_email,
    deletedByName: organization.deleted_by_name,
    deletedByUserId: organization.deleted_by_user_id,
    deletedAt: organization.deleted_at,
    id: organization.id,
    memberCount: organization.member_count,
    name: organization.name,
    ownerEmail: organization.owner_email,
    ownerName: organization.owner_name,
    slug: organization.slug,
  };
}

interface AdminRequirementRow {
  id: string;
  kind: "form" | "background_check" | "credit_check";
  title: string;
  due_date: string;
  status: "pending" | "in_progress" | "submitted" | "complete";
  target_name: string | null;
  target_email: string;
  completed_at: string | null;
  checkr_invitation_status: string | null;
  checkr_result: string | null;
  checkr_report_id: string | null;
}

async function listAdminRequirements(env: Bindings, organizationId: string) {
  const result = await env.DB.prepare(
    `SELECT requirement.id, requirement.kind, requirement.title,
            requirement.due_date, requirement.status, requirement.completed_at,
            target.name AS target_name,
            COALESCE(target.email, invitation.email, requirement.target_email)
              AS target_email,
            requirement.checkr_invitation_status, requirement.checkr_result,
            requirement.checkr_report_id
     FROM employee_requirements AS requirement
     LEFT JOIN member ON member.id = requirement.member_id
     LEFT JOIN user AS target ON target.id = member.userId
     LEFT JOIN invitation ON invitation.id = requirement.invitation_id
     WHERE requirement.organization_id = ?
     ORDER BY requirement.due_date ASC, requirement.created_at ASC`,
  )
    .bind(organizationId)
    .all<AdminRequirementRow>();
  const dashboard =
    env.CHECKR_ENV === "production"
      ? "https://dashboard.checkr.com"
      : "https://dashboard.checkrhq-staging.net";
  return result.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    dueDate: row.due_date,
    status: row.status,
    targetName: row.target_name,
    targetEmail: row.target_email,
    completedAt: row.completed_at,
    checkrInvitationStatus: row.checkr_invitation_status,
    checkrResult: row.checkr_result,
    checkrReportUrl: row.checkr_report_id
      ? `${dashboard}/reports/${encodeURIComponent(row.checkr_report_id)}`
      : null,
  }));
}

adminOrganizations.delete("/:organizationId", async (context) => {
  const organizationId = context.req.param("organizationId");
  const actor = context.get("authSession").user;
  let checkoutGuard: string | null;
  try {
    ({ checkoutGuard } = await cancelOrganizationSubscription(
      context.env,
      organizationId,
    ));
  } catch (cause) {
    console.error("Could not cancel organization billing.", cause);
    return context.json(
      {
        error:
          "The Stripe subscription could not be canceled, so the organization was not deleted.",
      },
      502,
    );
  }
  let deletion: Awaited<ReturnType<typeof markOrganizationForDeletion>>;
  try {
    deletion = await markOrganizationForDeletion(
      context.env.DB,
      organizationId,
      actor.id,
      checkoutGuard,
    );
  } catch (cause) {
    console.error("Could not record organization deletion.", cause);
    await recoverCheckoutAfterFailedDeletion(
      context.env.DB,
      organizationId,
      checkoutGuard,
    );
    return context.json(
      {
        error:
          "Billing was canceled, but the organization could not be deleted. Checkout was re-enabled so billing can be restarted.",
      },
      500,
    );
  }
  if (!deletion) {
    await recoverCheckoutAfterFailedDeletion(
      context.env.DB,
      organizationId,
      checkoutGuard,
    );
    const organization = await context.env.DB.prepare(
      "SELECT deletedAt FROM organization WHERE id = ?",
    )
      .bind(organizationId)
      .first<{ deletedAt: string | null }>();
    if (!organization) {
      return context.json({ error: "Organization not found." }, 404);
    }
    return context.json(
      { error: "Organization is already marked for deletion." },
      409,
    );
  }

  return context.json({
    ...deletion,
    deletedByEmail: actor.email,
    deletedByName: actor.name,
    deletedByUserId: actor.id,
  });
});

adminOrganizations.post("/:organizationId/restore", async (context) => {
  const organizationId = context.req.param("organizationId");
  const restoration = await restoreOrganization(context.env.DB, organizationId);
  if (!restoration) {
    const organization = await context.env.DB.prepare(
      "SELECT deletedAt FROM organization WHERE id = ?",
    )
      .bind(organizationId)
      .first<{ deletedAt: string | null }>();
    if (!organization) {
      return context.json({ error: "Organization not found." }, 404);
    }
    return context.json(
      { error: "Organization is not marked for deletion." },
      409,
    );
  }
  return context.json(restoration);
});

export { adminOrganizations };
