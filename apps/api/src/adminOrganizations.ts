import { Hono } from "hono";
import type { Bindings } from "./types";

const adminOrganizations = new Hono<{ Bindings: Bindings }>();

interface OrganizationRow {
  created_at: number | string;
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
            owner.name AS owner_name, owner.email AS owner_email,
            COUNT(member.id) AS member_count
     FROM organization
     LEFT JOIN user AS owner
       ON owner.defaultOrganizationId = organization.id
     LEFT JOIN member ON member.organizationId = organization.id
     GROUP BY organization.id
     ORDER BY organization.createdAt DESC
     LIMIT 100`,
  ).all<OrganizationRow>();

  return context.json({
    organizations: result.results.map((organization) => ({
      createdAt: organization.created_at,
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

export { adminOrganizations };
