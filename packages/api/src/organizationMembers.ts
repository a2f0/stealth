import { and, asc, count, eq, like, sql } from "drizzle-orm";
import { getDb } from "./db";
import { member, user } from "./schema";

interface OrganizationMember {
  id: string;
  role: string;
  twoFactorEnabled: boolean;
  twoFactorRequired: boolean;
  user: {
    email: string;
    id: string;
    name: string;
  };
}

export async function listOrganizationMembers(
  database: D1Database,
  organizationId: string,
) {
  const rows = await getDb(database)
    .select({
      id: member.id,
      role: member.role,
      twoFactorRequired: member.twoFactorRequired,
      userId: user.id,
      name: user.name,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))
    .orderBy(asc(user.name));
  return rows.map(
    ({
      email,
      id,
      name,
      role,
      twoFactorEnabled,
      twoFactorRequired,
      userId,
    }): OrganizationMember => ({
      id,
      role,
      twoFactorEnabled: Boolean(twoFactorEnabled),
      twoFactorRequired: Boolean(twoFactorRequired),
      user: { email, id: userId, name },
    }),
  );
}

/** Members' names and addresses, for choosing a person to assign. */
export async function listMemberDirectory(
  database: D1Database,
  organizationId: string,
) {
  return getDb(database)
    .select({ id: user.id, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))
    .orderBy(asc(sql`${user.name} collate nocase`));
}

export async function countOrganizationOwners(
  database: D1Database,
  organizationId: string,
) {
  const result = await getDb(database)
    .select({ count: count() })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        like(
          sql`(',' || replace(${member.role}, ' ', '') || ',')`,
          "%,owner,%",
        ),
      ),
    )
    .get();
  return result?.count ?? 0;
}

export function canManageOrganization(role: string) {
  return role
    .split(",")
    .some((value) => ["owner", "admin"].includes(value.trim()));
}

export function isOrganizationOwner(role: string) {
  return role.split(",").some((value) => value.trim() === "owner");
}
