ALTER TABLE objects ADD COLUMN upload_token TEXT;
ALTER TABLE objects ADD COLUMN upload_lease_expires_at TEXT;

CREATE INDEX objects_pending_upload_cleanup_idx
ON objects (
  kind,
  deletion_pending,
  upload_lease_expires_at,
  cleanup_claimed_at,
  created_at
);
