CREATE TABLE "team" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL
    REFERENCES "organization" ("id") ON DELETE CASCADE,
  "memberCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE,
  UNIQUE ("organizationId", "name")
);

CREATE TABLE "teamMember" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "teamId" TEXT NOT NULL REFERENCES "team" ("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "membershipKey" TEXT UNIQUE,
  "createdAt" DATE,
  UNIQUE ("teamId", "userId")
);

CREATE TABLE "organization_group_capability" (
  "organization_id" TEXT NOT NULL
    REFERENCES "organization" ("id") ON DELETE CASCADE,
  "team_id" TEXT NOT NULL REFERENCES "team" ("id") ON DELETE CASCADE,
  "capability" TEXT NOT NULL,
  PRIMARY KEY ("team_id", "capability")
);

ALTER TABLE "session" ADD COLUMN "activeTeamId" TEXT;
ALTER TABLE "invitation" ADD COLUMN "teamId" TEXT;

CREATE INDEX "team_organizationId_idx" ON "team" ("organizationId");
CREATE INDEX "teamMember_teamId_idx" ON "teamMember" ("teamId");
CREATE INDEX "teamMember_userId_idx" ON "teamMember" ("userId");
CREATE INDEX "organization_group_capability_lookup_idx"
ON "organization_group_capability" ("organization_id", "capability");

INSERT INTO "team" (
  "id", "name", "organizationId", "memberCount", "createdAt", "updatedAt"
)
SELECT
  'team_finance_' || "id",
  'Finance',
  "id",
  0,
  "createdAt",
  "createdAt"
FROM "organization";

INSERT INTO "teamMember" (
  "id", "teamId", "userId", "membershipKey", "createdAt"
)
SELECT
  'team_member_finance_' || "member"."id",
  'team_finance_' || "member"."organizationId",
  "member"."userId",
  NULL,
  "member"."createdAt"
FROM "member"
WHERE
  ',' || replace("member"."role", ' ', '') || ',' LIKE '%,owner,%'
  OR ',' || replace("member"."role", ' ', '') || ',' LIKE '%,admin,%';

UPDATE "team"
SET "memberCount" = (
  SELECT COUNT(*) FROM "teamMember"
  WHERE "teamMember"."teamId" = "team"."id"
);

INSERT INTO "organization_group_capability" (
  "organization_id", "team_id", "capability"
)
SELECT "id", 'team_finance_' || "id", 'finance'
FROM "organization";
