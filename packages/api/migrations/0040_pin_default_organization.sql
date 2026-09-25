-- Explicit account choices survive later organization creation or invitations.
ALTER TABLE "user" ADD COLUMN "defaultOrganizationPinned" INTEGER NOT NULL
  DEFAULT 0 CHECK ("defaultOrganizationPinned" IN (0, 1));
