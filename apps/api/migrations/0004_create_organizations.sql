CREATE TABLE "organization" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "logo" TEXT,
  "createdAt" DATE NOT NULL,
  "metadata" TEXT
);

CREATE TABLE "member" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL
    REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "createdAt" DATE NOT NULL,
  UNIQUE ("organizationId", "userId")
);

CREATE TABLE "invitation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL
    REFERENCES "organization" ("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT,
  "status" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "inviterId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

ALTER TABLE "user" ADD COLUMN "defaultOrganizationId" TEXT
  REFERENCES "organization" ("id") ON DELETE SET NULL;
ALTER TABLE "session" ADD COLUMN "activeOrganizationId" TEXT;

CREATE INDEX "organization_slug_idx" ON "organization" ("slug");
CREATE INDEX "member_organizationId_idx" ON "member" ("organizationId");
CREATE INDEX "member_userId_idx" ON "member" ("userId");
CREATE INDEX "invitation_organizationId_idx"
ON "invitation" ("organizationId");
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");

INSERT INTO "organization" ("id", "name", "slug", "createdAt")
SELECT
  'org_' || "id",
  CASE
    WHEN trim("name") = '' THEN 'My Organization'
    ELSE trim("name") || '''s Organization'
  END,
  'personal-' || lower("id"),
  "createdAt"
FROM "user";

INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
SELECT
  'member_' || "id",
  'org_' || "id",
  "id",
  'owner',
  "createdAt"
FROM "user";

UPDATE "user"
SET "defaultOrganizationId" = 'org_' || "id";

UPDATE "session"
SET "activeOrganizationId" = (
  SELECT "defaultOrganizationId"
  FROM "user"
  WHERE "user"."id" = "session"."userId"
);
