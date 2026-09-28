import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type Db, getDb } from "./db";
import {
  invitation,
  member,
  organization,
  organizationBilling,
  session,
  team,
  user,
} from "./schema";

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
  const db = getDb(database);
  const deletedAt = new Date().toISOString();
  const markedDeleted = exists(
    db
      .select({ one: sql`1` })
      .from(organization)
      .where(
        and(
          eq(organization.id, organizationId),
          eq(organization.deletedAt, deletedAt),
          eq(organization.deletedByUserId, deletedByUserId),
        ),
      ),
  );
  const results = await db.batch([
    db
      .update(organization)
      .set({ deletedAt, deletedByUserId })
      .where(
        and(
          eq(organization.id, organizationId),
          isNull(organization.deletedAt),
          exists(
            db
              .select({ one: sql`1` })
              .from(organizationBilling)
              .where(
                and(
                  eq(organizationBilling.organizationId, organization.id),
                  sql`${organizationBilling.checkoutDisabledAt} IS ${checkoutGuard}`,
                  sql`COALESCE(${organizationBilling.checkoutDisabledExpiresAt}, 0) > unixepoch()`,
                ),
              ),
          ),
        ),
      ),
    db
      .update(invitation)
      .set({ status: "canceled" })
      .where(
        and(
          eq(invitation.organizationId, organizationId),
          eq(invitation.status, "pending"),
          markedDeleted,
        ),
      ),
    reassignDefaultOrganizations(db, organizationId, markedDeleted),
    clearActiveSessions(db, organizationId, markedDeleted),
  ]);

  if (results[0]?.meta.changes !== 1) return undefined;
  return { deletedAt, organizationId };
}

/** Moves users whose default was the deleted organization to their next one. */
function reassignDefaultOrganizations(
  db: Db,
  organizationId: string,
  markedDeleted: SQL,
) {
  return db
    .update(user)
    .set({
      defaultOrganizationId: sql`${db
        .select({ organizationId: member.organizationId })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(
          and(
            eq(member.userId, user.id),
            ne(member.organizationId, organizationId),
            isNull(organization.deletedAt),
          ),
        )
        .orderBy(asc(member.createdAt), asc(member.id))
        .limit(1)}`,
    })
    .where(and(eq(user.defaultOrganizationId, organizationId), markedDeleted));
}

/** Points sessions away from the deleted organization and its teams. */
function clearActiveSessions(
  db: Db,
  organizationId: string,
  markedDeleted: SQL,
) {
  return db
    .update(session)
    .set({
      activeOrganizationId: sql`CASE
        WHEN ${session.activeOrganizationId} = ${organizationId} THEN ${db
          .select({ defaultOrganizationId: user.defaultOrganizationId })
          .from(user)
          .where(eq(user.id, session.userId))}
        ELSE ${session.activeOrganizationId}
      END`,
      activeTeamId: null,
    })
    .where(
      and(
        or(
          eq(session.activeOrganizationId, organizationId),
          inArray(
            session.activeTeamId,
            db
              .select({ id: team.id })
              .from(team)
              .where(eq(team.organizationId, organizationId)),
          ),
        ),
        markedDeleted,
      ),
    );
}

export async function restoreOrganization(
  database: D1Database,
  organizationId: string,
): Promise<OrganizationRestoration | undefined> {
  const db = getDb(database);
  const billing = await db
    .select({ checkoutDisabledAt: organizationBilling.checkoutDisabledAt })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, organizationId))
    .get();
  const result = await db
    .update(organization)
    .set({ deletedAt: null, deletedByUserId: null })
    .where(
      and(
        eq(organization.id, organizationId),
        isNotNull(organization.deletedAt),
        sql`${db
          .select({
            checkoutDisabledAt: organizationBilling.checkoutDisabledAt,
          })
          .from(organizationBilling)
          .where(eq(organizationBilling.organizationId, organization.id))} IS ${
          billing?.checkoutDisabledAt ?? null
        }`,
      ),
    )
    .run();
  if (result.meta.changes < 1) return undefined;
  return { organizationId };
}
