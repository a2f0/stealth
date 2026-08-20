interface OrganizationMember {
  id: string;
  role: string;
  user: {
    email: string;
    id: string;
    name: string;
  };
}

interface OrganizationMemberRow {
  email: string;
  id: string;
  name: string;
  role: string;
  user_id: string;
}

export async function listOrganizationMembers(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT member.id, member.role, user.id AS user_id,
              user.name, user.email
       FROM member
       JOIN user ON user.id = member.userId
       WHERE member.organizationId = ?
       ORDER BY user.name ASC`,
    )
    .bind(organizationId)
    .all<OrganizationMemberRow>();
  return result.results.map(
    ({ email, id, name, role, user_id: userId }): OrganizationMember => ({
      id,
      role,
      user: { email, id: userId, name },
    }),
  );
}

export async function countOrganizationOwners(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM member
       WHERE organizationId = ?
         AND (',' || replace(role, ' ', '') || ',') LIKE '%,owner,%'`,
    )
    .bind(organizationId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export function canManageOrganization(role: string) {
  return role
    .split(",")
    .some((value) => ["owner", "admin"].includes(value.trim()));
}
