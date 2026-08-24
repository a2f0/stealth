CREATE TABLE audit_template_families (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL
    CHECK (scope IN ('global', 'organization')),
  organization_id TEXT
    REFERENCES organization (id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  created_by TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope = 'global' AND organization_id IS NULL) OR
    (scope = 'organization' AND organization_id IS NOT NULL)
  )
);

CREATE TABLE audit_template_versions (
  id TEXT NOT NULL PRIMARY KEY,
  template_id TEXT NOT NULL
    REFERENCES audit_template_families (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  definition TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (template_id, version)
);

INSERT INTO audit_template_families (
  id,
  scope,
  organization_id,
  current_version,
  created_by,
  created_at,
  updated_at
)
SELECT
  id,
  'organization',
  organization_id,
  1,
  created_by,
  created_at,
  updated_at
FROM audit_templates;

INSERT INTO audit_template_versions (
  id,
  template_id,
  version,
  name,
  description,
  definition,
  status,
  created_by,
  created_at
)
SELECT
  id || ':v1',
  id,
  1,
  name,
  description,
  definition,
  status,
  created_by,
  updated_at
FROM audit_templates;

ALTER TABLE audits ADD COLUMN template_family_id TEXT
  REFERENCES audit_template_families (id) ON DELETE SET NULL;
ALTER TABLE audits ADD COLUMN template_version_id TEXT
  REFERENCES audit_template_versions (id) ON DELETE SET NULL;
ALTER TABLE audits ADD COLUMN template_version INTEGER;

UPDATE audits
SET
  template_family_id = template_id,
  template_version_id = template_id || ':v1',
  template_version = 1
WHERE template_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM audit_template_families
    WHERE audit_template_families.id = audits.template_id
  );

CREATE INDEX audit_template_families_scope_idx
ON audit_template_families (scope, organization_id, updated_at DESC);

CREATE INDEX audit_template_versions_template_idx
ON audit_template_versions (template_id, version DESC);

CREATE INDEX audits_template_family_idx
ON audits (template_family_id, template_version);
