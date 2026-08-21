import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import {
  markOrganizationForDeletion,
  restoreOrganization,
} from "./organizationDeletion";
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

adminOrganizations.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT organization.id, organization.name, organization.slug,
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
     LEFT JOIN member ON member.organizationId = organization.id
     GROUP BY organization.id
     ORDER BY organization.createdAt DESC
     LIMIT 100`,
  ).all<OrganizationRow>();

  return context.json({
    organizations: result.results.map((organization) => ({
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
    })),
  });
});

adminOrganizations.delete("/:organizationId", async (context) => {
  const organizationId = context.req.param("organizationId");
  const actor = context.get("authSession").user;
  const deletion = await markOrganizationForDeletion(
    context.env.DB,
    organizationId,
    actor.id,
  );
  if (!deletion) {
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
