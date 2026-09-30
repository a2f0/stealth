import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { getDb } from "./db";
import { member, organization, user } from "./schema";
import type { Bindings } from "./types";

const accountSettings = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

accountSettings.patch("/default-organization", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (
    typeof body !== "object" ||
    body === null ||
    !("organizationId" in body) ||
    typeof body.organizationId !== "string" ||
    !body.organizationId
  ) {
    return context.json({ error: "An organization is required." }, 400);
  }

  const userId = context.get("authSession").user.id;
  const db = getDb(context.env.DB);
  const result = await db
    .update(user)
    .set({
      defaultOrganizationId: body.organizationId,
      defaultOrganizationPinned: 1,
    })
    .where(
      and(
        eq(user.id, userId),
        exists(
          db
            .select({ one: sql`1` })
            .from(member)
            .innerJoin(organization, eq(organization.id, member.organizationId))
            .where(
              and(
                eq(member.userId, user.id),
                eq(member.organizationId, body.organizationId),
                isNull(organization.deletedAt),
              ),
            ),
        ),
      ),
    );
  if (!result.meta.changes) {
    return context.json({ error: "Organization is unavailable." }, 403);
  }
  return context.json({ defaultOrganizationId: body.organizationId });
});

export { accountSettings };
