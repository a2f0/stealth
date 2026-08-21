ALTER TABLE inbound_emails ADD COLUMN deleted_at TEXT;

ALTER TABLE inbound_emails ADD COLUMN deleted_by_user_id TEXT
  REFERENCES "user" ("id") ON DELETE SET NULL;

CREATE INDEX inbound_emails_organization_deleted_received_idx
ON inbound_emails (organization_id, deleted_at, received_at DESC);

CREATE INDEX inbound_emails_deleted_at_idx
ON inbound_emails (deleted_at)
WHERE deleted_at IS NOT NULL;
