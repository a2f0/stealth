import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { markOrganizationForDeletion } from "./organizationDeletion";
import {
  canManageOrganization,
  isOrganizationOwner,
  listOrganizationMembers,
} from "./organizationMembers";
import type { Bindings } from "./types";

interface InvitationRow {
  email: string;
  expiresAt: string;
  id: string;
  role: string;
  status: string;
}

interface OrganizationRow {
  id: string;
  name: string;
}

type OrganizationSettingsEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};

const organizationSettings = new Hono<OrganizationSettingsEnv>();

organizationSettings.get("/organizations", async (context) => {
  const userId = context.get("authSession").user.id;
  const result = await context.env.DB.prepare(
    `SELECT organization.id, organization.name
     FROM organization
     JOIN member ON member.organizationId = organization.id
     WHERE member.userId = ? AND organization.deletedAt IS NULL
     ORDER BY member.createdAt ASC, member.id ASC`,
  )
    .bind(userId)
    .all<OrganizationRow>();
  return context.json({ organizations: result.results });
});

organizationSettings.get("/people", async (context) => {
  const organizationId = context.get("organizationId");
  const memberRole = context.get("organizationRole");
  const [members, invitations] = await Promise.all([
    listOrganizationMembers(context.env.DB, organizationId),
    canManageOrganization(memberRole)
      ? listPendingInvitations(context.env.DB, organizationId)
      : Promise.resolve([]),
  ]);
  return context.json({ invitations, memberRole, members });
});

organizationSettings.delete("/current", async (context) => {
  const organizationId = context.get("organizationId");
  const userId = context.get("authSession").user.id;
  if (!isOrganizationOwner(context.get("organizationRole"))) {
    return context.json(
      { error: "Only an organization owner can delete this organization." },
      403,
    );
  }

  const deletion = await markOrganizationForDeletion(
    context.env.DB,
    organizationId,
    userId,
  );
  if (!deletion) {
    return context.json({ error: "Organization was already deleted." }, 409);
  }
  return context.json(deletion);
});

async function listPendingInvitations(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT id, email, role, status, expiresAt
       FROM invitation
       WHERE organizationId = ? AND status = 'pending'
       ORDER BY createdAt DESC`,
    )
    .bind(organizationId)
    .all<InvitationRow>();
  return result.results;
}

export { organizationSettings };
