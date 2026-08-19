CREATE TABLE objects_by_organization (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL
);

INSERT INTO objects_by_organization (
  id,
  organization_id,
  object_key,
  filename,
  content_type,
  size,
  created_at
)
SELECT
  id,
  (SELECT id FROM organization ORDER BY createdAt ASC LIMIT 1),
  object_key,
  filename,
  content_type,
  size,
  created_at
FROM objects;

DROP TABLE objects;
ALTER TABLE objects_by_organization RENAME TO objects;

CREATE INDEX objects_organization_created_at_idx
ON objects (organization_id, created_at DESC);
