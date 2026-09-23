-- Allow inbound emails to link to equipment. SQLite cannot alter a CHECK
-- constraint, so the link table is rebuilt. Its cleanup triggers name the
-- table, and SQLite rejects the rename while a trigger refers to a missing
-- table, so they are dropped first and recreated afterwards.
DROP TRIGGER remove_library_folder_email_links;
DROP TRIGGER remove_finance_transaction_email_links;

CREATE TABLE inbound_email_links_rebuilt (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  email_id TEXT NOT NULL
    REFERENCES inbound_emails (id) ON DELETE CASCADE,
  target_type TEXT NOT NULL
    CHECK (
      target_type IN ('equipment', 'finance_transaction', 'library_folder')
    ),
  target_id TEXT NOT NULL,
  created_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (email_id, target_type, target_id)
);

-- Copy in insertion order; links list by created_at, then rowid.
INSERT INTO inbound_email_links_rebuilt
  (id, organization_id, email_id, target_type, target_id, created_by,
   created_at)
SELECT id, organization_id, email_id, target_type, target_id, created_by,
       created_at
FROM inbound_email_links
ORDER BY rowid;

DROP TABLE inbound_email_links;
ALTER TABLE inbound_email_links_rebuilt RENAME TO inbound_email_links;

CREATE INDEX inbound_email_links_target_idx
ON inbound_email_links (organization_id, target_type, target_id);

CREATE TRIGGER remove_library_folder_email_links
AFTER DELETE ON library_folders
BEGIN
  DELETE FROM inbound_email_links
  WHERE organization_id = OLD.organization_id
    AND target_type = 'library_folder' AND target_id = OLD.id;
END;

CREATE TRIGGER remove_finance_transaction_email_links
AFTER DELETE ON plaid_transactions
BEGIN
  DELETE FROM inbound_email_links
  WHERE organization_id = OLD.organization_id
    AND target_type = 'finance_transaction' AND target_id = OLD.id;
END;

CREATE TRIGGER remove_equipment_email_links
AFTER DELETE ON equipment
BEGIN
  DELETE FROM inbound_email_links
  WHERE organization_id = OLD.organization_id
    AND target_type = 'equipment' AND target_id = OLD.id;
END;
