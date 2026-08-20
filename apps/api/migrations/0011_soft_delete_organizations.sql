ALTER TABLE "organization" ADD COLUMN "deletedAt" DATE;

CREATE INDEX "organization_deletedAt_idx"
ON "organization" ("deletedAt")
WHERE "deletedAt" IS NOT NULL;

CREATE TRIGGER "organization_before_delete_keep_defaults_valid"
BEFORE DELETE ON "organization"
BEGIN
  UPDATE "user"
  SET "defaultOrganizationId" = (
    SELECT "member"."organizationId"
    FROM "member"
    JOIN "organization" AS "fallback"
      ON "fallback"."id" = "member"."organizationId"
    WHERE "member"."userId" = "user"."id"
      AND "member"."organizationId" != OLD."id"
      AND "fallback"."deletedAt" IS NULL
    ORDER BY "member"."createdAt" ASC, "member"."id" ASC
    LIMIT 1
  )
  WHERE "defaultOrganizationId" = OLD."id";

  UPDATE "session"
  SET "activeOrganizationId" = CASE
        WHEN "activeOrganizationId" = OLD."id" THEN (
          SELECT "defaultOrganizationId"
          FROM "user"
          WHERE "user"."id" = "session"."userId"
        )
        ELSE "activeOrganizationId"
      END,
      "activeTeamId" = NULL
  WHERE "activeOrganizationId" = OLD."id"
    OR "activeTeamId" IN (
      SELECT "id" FROM "team" WHERE "organizationId" = OLD."id"
    );
END;

DROP TRIGGER IF EXISTS "member_after_delete_keep_organization_defaults_valid";

CREATE TRIGGER "member_after_delete_keep_organization_defaults_valid"
AFTER DELETE ON "member"
BEGIN
  UPDATE "user"
  SET "defaultOrganizationId" = (
    SELECT "member"."organizationId"
    FROM "member"
    JOIN "organization"
      ON "organization"."id" = "member"."organizationId"
    WHERE "member"."userId" = OLD."userId"
      AND "organization"."deletedAt" IS NULL
    ORDER BY "member"."createdAt" ASC, "member"."id" ASC
    LIMIT 1
  )
  WHERE "id" = OLD."userId"
    AND "defaultOrganizationId" = OLD."organizationId";

  UPDATE "session"
  SET "activeOrganizationId" = (
    SELECT "defaultOrganizationId"
    FROM "user"
    WHERE "id" = OLD."userId"
  )
  WHERE "userId" = OLD."userId"
    AND "activeOrganizationId" = OLD."organizationId";
END;
