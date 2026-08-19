CREATE TRIGGER "member_after_delete_keep_organization_defaults_valid"
AFTER DELETE ON "member"
BEGIN
  UPDATE "user"
  SET "defaultOrganizationId" = (
    SELECT "organizationId"
    FROM "member"
    WHERE "userId" = OLD."userId"
    ORDER BY "createdAt" ASC, "id" ASC
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
