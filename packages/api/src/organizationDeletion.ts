interface OrganizationDeletion {
  deletedAt: string;
  organizationId: string;
}

interface OrganizationRestoration {
  organizationId: string;
}

export async function markOrganizationForDeletion(
  database: D1Database,
  organizationId: string,
  deletedByUserId: string,
  checkoutGuard: string | null,
): Promise<OrganizationDeletion | undefined> {
  const deletedAt = new Date().toISOString();
  const results = await database.batch([
    database
      .prepare(
        `UPDATE organization
         SET deletedAt = ?, deletedByUserId = ?
         WHERE id = ? AND deletedAt IS NULL
           AND EXISTS (
             SELECT 1 FROM organization_billing
             WHERE organization_id = organization.id
               AND checkout_disabled_at IS ?
               AND COALESCE(checkout_disabled_expires_at, 0) > unixepoch()
           )`,
      )
      .bind(deletedAt, deletedByUserId, organizationId, checkoutGuard),
    database
      .prepare(
        `UPDATE invitation
         SET status = 'canceled'
         WHERE organizationId = ? AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM organization
             WHERE id = ? AND deletedAt = ? AND deletedByUserId = ?
           )`,
      )
      .bind(organizationId, organizationId, deletedAt, deletedByUserId),
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
         WHERE defaultOrganizationId = ?
           AND EXISTS (
             SELECT 1 FROM organization
             WHERE id = ? AND deletedAt = ? AND deletedByUserId = ?
           )`,
      )
      .bind(
        organizationId,
        organizationId,
        organizationId,
        deletedAt,
        deletedByUserId,
      ),
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
         WHERE (
           activeOrganizationId = ?
           OR activeTeamId IN (
              SELECT id FROM team WHERE organizationId = ?
            )
         )
           AND EXISTS (
             SELECT 1 FROM organization
             WHERE id = ? AND deletedAt = ? AND deletedByUserId = ?
           )`,
      )
      .bind(
        organizationId,
        organizationId,
        organizationId,
        organizationId,
        deletedAt,
        deletedByUserId,
      ),
  ]);

  if (results[0]?.meta.changes !== 1) return undefined;
  return { deletedAt, organizationId };
}

export async function restoreOrganization(
  database: D1Database,
  organizationId: string,
): Promise<OrganizationRestoration | undefined> {
  const billing = await database
    .prepare(
      `SELECT checkout_disabled_at FROM organization_billing
       WHERE organization_id = ?`,
    )
    .bind(organizationId)
    .first<{ checkout_disabled_at: string | null }>();
  const result = await database
    .prepare(
      `UPDATE organization
       SET deletedAt = NULL, deletedByUserId = NULL
       WHERE id = ? AND deletedAt IS NOT NULL
         AND (
           SELECT checkout_disabled_at FROM organization_billing
           WHERE organization_id = organization.id
         ) IS ?`,
    )
    .bind(organizationId, billing?.checkout_disabled_at ?? null)
    .run();
  if (result.meta.changes < 1) return undefined;
  return { organizationId };
}
