CREATE TABLE "audit_templates" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organization_id" TEXT NOT NULL
    REFERENCES "organization" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "definition" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "created_by" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE TABLE "audits" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organization_id" TEXT NOT NULL
    REFERENCES "organization" ("id") ON DELETE CASCADE,
  "template_id" TEXT REFERENCES "audit_templates" ("id") ON DELETE SET NULL,
  "template_name" TEXT NOT NULL,
  "definition" TEXT NOT NULL,
  "responses" TEXT NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'in_progress',
  "started_by" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  "completed_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE TABLE "audit_issues" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organization_id" TEXT NOT NULL
    REFERENCES "organization" ("id") ON DELETE CASCADE,
  "audit_id" TEXT NOT NULL REFERENCES "audits" ("id") ON DELETE CASCADE,
  "item_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "priority" TEXT NOT NULL DEFAULT 'medium',
  "status" TEXT NOT NULL DEFAULT 'open',
  "assigned_to" TEXT REFERENCES "user" ("id") ON DELETE SET NULL,
  "created_by" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX "audit_templates_organization_idx"
ON "audit_templates" ("organization_id", "updated_at");
CREATE INDEX "audits_organization_idx"
ON "audits" ("organization_id", "created_at");
CREATE INDEX "audit_issues_audit_idx" ON "audit_issues" ("audit_id");
CREATE INDEX "audit_issues_assigned_to_idx"
ON "audit_issues" ("assigned_to", "status");
