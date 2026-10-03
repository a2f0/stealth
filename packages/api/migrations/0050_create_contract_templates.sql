-- A template family has immutable versions. Roles describe who signs, without
-- identifying a person; a new contract copies the selected version's PDF.
CREATE TABLE contract_templates (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX contract_templates_organization_idx
ON contract_templates (organization_id, updated_at DESC);

CREATE TABLE contract_template_versions (
  id TEXT NOT NULL PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES contract_templates (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL,
  document_object_key TEXT NOT NULL,
  document_filename TEXT NOT NULL,
  document_size INTEGER NOT NULL CHECK (document_size > 0),
  document_sha256 TEXT NOT NULL,
  document_page_count INTEGER NOT NULL CHECK (document_page_count > 0),
  created_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (template_id, version)
);

ALTER TABLE contracts ADD COLUMN template_version_id TEXT
  REFERENCES contract_template_versions (id) ON DELETE SET NULL;
ALTER TABLE contracts ADD COLUMN template_name TEXT;
ALTER TABLE contracts ADD COLUMN template_version INTEGER;

-- Shared documents are queued once when a family is deleted, including an
-- organization purge. Issued contracts own separate copies of those documents.
CREATE TRIGGER queue_contract_template_cleanup
BEFORE DELETE ON contract_templates
BEGIN
  INSERT OR REPLACE INTO deleted_object_cleanup
    (id, organization_id, object_key, deleted_at, cleanup_token,
     cleanup_claimed_at)
  SELECT 'contract-template:' || document_object_key, OLD.organization_id,
         document_object_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL
  FROM contract_template_versions
  WHERE template_id = OLD.id
  GROUP BY document_object_key;
END;
