ALTER TABLE objects
ADD COLUMN kind TEXT NOT NULL DEFAULT 'library'
CHECK (kind IN ('library', 'audit_issue_image'));

CREATE INDEX objects_organization_kind_created_at_idx
ON objects (organization_id, kind, created_at DESC);
