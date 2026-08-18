CREATE TABLE inbound_emails (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  subject TEXT,
  raw_object_key TEXT NOT NULL UNIQUE,
  raw_size INTEGER NOT NULL CHECK (raw_size >= 0),
  received_at TEXT NOT NULL
);

CREATE INDEX inbound_emails_received_at_idx
ON inbound_emails (received_at DESC);

CREATE TABLE inbound_email_attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES inbound_emails (id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  disposition TEXT,
  content_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX inbound_email_attachments_email_id_idx
ON inbound_email_attachments (email_id);
