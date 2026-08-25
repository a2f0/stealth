ALTER TABLE objects ADD COLUMN cleanup_token TEXT;
ALTER TABLE objects ADD COLUMN cleanup_claimed_at TEXT;

CREATE INDEX objects_pending_cleanup_idx
ON objects (kind, deletion_pending, cleanup_claimed_at, created_at);
