CREATE TRIGGER "organization_after_restore_defaults"
AFTER UPDATE OF "deletedAt" ON "organization"
WHEN OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS NULL
BEGIN
  UPDATE "user"
  SET "defaultOrganizationId" = NEW."id"
  WHERE "defaultOrganizationId" IS NULL
    AND EXISTS (
      SELECT 1
      FROM "member"
      WHERE "member"."userId" = "user"."id"
        AND "member"."organizationId" = NEW."id"
    );

  UPDATE "session"
  SET "activeOrganizationId" = NEW."id"
  WHERE "activeOrganizationId" IS NULL
    AND EXISTS (
      SELECT 1
      FROM "member"
      WHERE "member"."userId" = "session"."userId"
        AND "member"."organizationId" = NEW."id"
    )
    AND EXISTS (
      SELECT 1
      FROM "user"
      WHERE "user"."id" = "session"."userId"
        AND "user"."defaultOrganizationId" = NEW."id"
    );
END;
