CREATE TABLE inbound_emails_by_organization (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  message_id TEXT,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  subject TEXT,
  raw_object_key TEXT NOT NULL UNIQUE,
  raw_size INTEGER NOT NULL CHECK (raw_size >= 0),
  received_at TEXT NOT NULL
);

INSERT INTO inbound_emails_by_organization (
  id,
  organization_id,
  message_id,
  envelope_from,
  envelope_to,
  subject,
  raw_object_key,
  raw_size,
  received_at
)
SELECT
  id,
  (
    SELECT id
    FROM organization
    WHERE lower(trim(name)) = 'tearleads, llc'
      AND deletedAt IS NULL
    ORDER BY createdAt ASC, id ASC
    LIMIT 1
  ),
  message_id,
  envelope_from,
  envelope_to,
  subject,
  raw_object_key,
  raw_size,
  received_at
FROM inbound_emails;

CREATE TABLE inbound_email_attachments_by_organization (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL
    REFERENCES inbound_emails_by_organization (id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  disposition TEXT,
  content_id TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO inbound_email_attachments_by_organization (
  id,
  email_id,
  object_key,
  filename,
  content_type,
  size,
  disposition,
  content_id,
  created_at
)
SELECT
  id,
  email_id,
  object_key,
  filename,
  content_type,
  size,
  disposition,
  content_id,
  created_at
FROM inbound_email_attachments;

DROP TABLE inbound_email_attachments;
DROP TABLE inbound_emails;
ALTER TABLE inbound_emails_by_organization RENAME TO inbound_emails;
ALTER TABLE inbound_email_attachments_by_organization
RENAME TO inbound_email_attachments;

CREATE INDEX inbound_emails_organization_received_at_idx
ON inbound_emails (organization_id, received_at DESC);

CREATE INDEX inbound_email_attachments_email_id_idx
ON inbound_email_attachments (email_id);
