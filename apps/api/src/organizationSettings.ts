import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import {
  canManageOrganization,
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

type OrganizationSettingsEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};

const organizationSettings = new Hono<OrganizationSettingsEnv>();

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
