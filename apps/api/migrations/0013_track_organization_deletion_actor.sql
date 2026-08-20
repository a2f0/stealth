ALTER TABLE "organization" ADD COLUMN "deletedByUserId" TEXT;

CREATE INDEX "organization_deletedByUserId_idx"
ON "organization" ("deletedByUserId")
WHERE "deletedByUserId" IS NOT NULL;
