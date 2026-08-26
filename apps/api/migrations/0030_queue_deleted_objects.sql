CREATE TABLE deleted_object_cleanup (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  deleted_at TEXT NOT NULL,
  cleanup_token TEXT,
  cleanup_claimed_at TEXT
);

CREATE INDEX deleted_object_cleanup_claim_idx
ON deleted_object_cleanup (deleted_at, cleanup_claimed_at);

CREATE TRIGGER queue_organization_object_cleanup
BEFORE DELETE ON organization
BEGIN
  INSERT OR REPLACE INTO deleted_object_cleanup (
    id,
    organization_id,
    object_key,
    deleted_at,
    cleanup_token,
    cleanup_claimed_at
  )
  SELECT
    object.id,
    object.organization_id,
    object.object_key,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL
  FROM objects AS object
  WHERE object.organization_id = OLD.id;
END;
