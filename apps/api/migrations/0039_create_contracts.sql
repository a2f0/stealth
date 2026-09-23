-- Contracts sent for electronic signature. The uploaded PDF and, once every
-- signer has signed, the stamped final PDF live in R2 under the
-- organization's prefix; everything else lives here.
CREATE TABLE contracts (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'completed', 'declined', 'voided')),
  signing_order TEXT NOT NULL DEFAULT 'parallel'
    CHECK (signing_order IN ('parallel', 'sequential')),
  due_date TEXT,
  reminder_interval_days INTEGER
    CHECK (
      reminder_interval_days IS NULL
      OR reminder_interval_days BETWEEN 1 AND 30
    ),
  document_object_key TEXT NOT NULL UNIQUE,
  document_filename TEXT NOT NULL,
  document_size INTEGER NOT NULL CHECK (document_size > 0),
  document_sha256 TEXT NOT NULL,
  document_page_count INTEGER NOT NULL CHECK (document_page_count > 0),
  final_object_key TEXT UNIQUE,
  final_sha256 TEXT,
  created_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  sent_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  completed_at TEXT,
  voided_at TEXT,
  void_reason TEXT,
  -- Bumped by every draft save, so a send only goes out for the draft it
  -- validated.
  revision INTEGER NOT NULL DEFAULT 0,
  -- The scheduled sweep that finishes stalled contracts claims each attempt
  -- before making it, and gives up after a few.
  resume_attempts INTEGER NOT NULL DEFAULT 0,
  resume_attempted_at TEXT
);

CREATE INDEX contracts_organization_updated_idx
ON contracts (organization_id, updated_at DESC);

-- A signer. Signing links carry a token derived from token_nonce, so they can
-- be re-sent in reminders; only its hash is stored for lookup.
CREATE TABLE contract_recipients (
  id TEXT NOT NULL PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  routing_order INTEGER NOT NULL DEFAULT 1 CHECK (routing_order >= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'declined')),
  token_nonce TEXT,
  token_hash TEXT UNIQUE,
  notified_at TEXT,
  last_reminded_at TEXT,
  viewed_at TEXT,
  signed_at TEXT,
  signed_ip TEXT,
  signed_user_agent TEXT,
  signature_image TEXT,
  initials_image TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX contract_recipients_contract_idx
ON contract_recipients (contract_id, routing_order);

-- Reminders scan recipients who still have to act.
CREATE INDEX contract_recipients_awaiting_idx
ON contract_recipients (status, notified_at);

-- A field placed on a page, as fractions of the page as displayed (after any
-- /Rotate), so placement is independent of render size.
CREATE TABLE contract_fields (
  id TEXT NOT NULL PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL
    REFERENCES contract_recipients (id) ON DELETE CASCADE,
  type TEXT NOT NULL
    CHECK (type IN ('signature', 'initials', 'date_signed', 'name', 'text')),
  page INTEGER NOT NULL CHECK (page >= 1),
  x REAL NOT NULL CHECK (x >= 0 AND x < 1),
  y REAL NOT NULL CHECK (y >= 0 AND y < 1),
  width REAL NOT NULL CHECK (width > 0 AND x + width <= 1.0001),
  height REAL NOT NULL CHECK (height > 0 AND y + height <= 1.0001),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  label TEXT,
  value TEXT
);

CREATE INDEX contract_fields_contract_idx
ON contract_fields (contract_id, page);

CREATE INDEX contract_fields_recipient_idx
ON contract_fields (recipient_id);

-- The audit trail printed on the certificate of completion.
CREATE TABLE contract_events (
  id TEXT NOT NULL PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  recipient_id TEXT,
  actor_user_id TEXT REFERENCES user (id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX contract_events_contract_idx
ON contract_events (contract_id, created_at);

-- Organization purges cascade contract rows; queue their R2 documents for the
-- deleted-object cleanup first, as organization objects already are.
CREATE TRIGGER queue_organization_contract_cleanup
BEFORE DELETE ON organization
BEGIN
  INSERT OR REPLACE INTO deleted_object_cleanup
    (id, organization_id, object_key, deleted_at, cleanup_token,
     cleanup_claimed_at)
  SELECT 'contract-document:' || contract.id, contract.organization_id,
         contract.document_object_key,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL
  FROM contracts AS contract
  WHERE contract.organization_id = OLD.id;

  INSERT OR REPLACE INTO deleted_object_cleanup
    (id, organization_id, object_key, deleted_at, cleanup_token,
     cleanup_claimed_at)
  SELECT 'contract-final:' || contract.id, contract.organization_id,
         contract.final_object_key,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL
  FROM contracts AS contract
  WHERE contract.organization_id = OLD.id
    AND contract.final_object_key IS NOT NULL;
END;
