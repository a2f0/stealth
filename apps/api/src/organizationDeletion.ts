interface OrganizationDeletion {
  deletedAt: string;
  organizationId: string;
}

export async function markOrganizationForDeletion(
  database: D1Database,
  organizationId: string,
  deletedByUserId: string,
): Promise<OrganizationDeletion | undefined> {
  const deletedAt = new Date().toISOString();
  const results = await database.batch([
    database
      .prepare(
        `UPDATE organization
         SET deletedAt = ?, deletedByUserId = ?
         WHERE id = ? AND deletedAt IS NULL`,
      )
      .bind(deletedAt, deletedByUserId, organizationId),
    database
      .prepare(
        `UPDATE invitation
         SET status = 'canceled'
         WHERE organizationId = ? AND status = 'pending'`,
      )
      .bind(organizationId),
    database
      .prepare(
        `UPDATE user
         SET defaultOrganizationId = (
           SELECT member.organizationId
           FROM member
           JOIN organization
             ON organization.id = member.organizationId
           WHERE member.userId = user.id
             AND member.organizationId != ?
             AND organization.deletedAt IS NULL
           ORDER BY member.createdAt ASC, member.id ASC
           LIMIT 1
         )
         WHERE defaultOrganizationId = ?`,
      )
      .bind(organizationId, organizationId),
    database
      .prepare(
        `UPDATE session
         SET activeOrganizationId = CASE
               WHEN activeOrganizationId = ? THEN (
                 SELECT defaultOrganizationId
                 FROM user
                 WHERE user.id = session.userId
               )
               ELSE activeOrganizationId
             END,
             activeTeamId = NULL
         WHERE activeOrganizationId = ?
            OR activeTeamId IN (
              SELECT id FROM team WHERE organizationId = ?
            )`,
      )
      .bind(organizationId, organizationId, organizationId),
  ]);

  if (results[0]?.meta.changes !== 1) return undefined;
  return { deletedAt, organizationId };
}
