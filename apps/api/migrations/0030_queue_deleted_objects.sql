CREATE TABLE deleted_object_cleanup (
  id TEXT NOT NULL PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  deleted_at TEXT NOT NULL,
  cleanup_token TEXT,
  cleanup_claimed_at TEXT
);

CREATE INDEX deleted_object_cleanup_claim_idx
ON deleted_object_cleanup (cleanup_claimed_at, deleted_at);

CREATE TRIGGER queue_deleted_object_cleanup
BEFORE DELETE ON objects
BEGIN
  INSERT OR REPLACE INTO deleted_object_cleanup (
    id,
    object_key,
    deleted_at,
    cleanup_token,
    cleanup_claimed_at
  ) VALUES (
    OLD.id,
    OLD.object_key,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL
  );
END;
