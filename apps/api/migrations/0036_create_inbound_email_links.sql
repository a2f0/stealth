-- Links an inbound email to a record elsewhere in the workspace. target_type
-- names the kind of record and target_id is that record's id. A polymorphic
-- reference cannot carry a foreign key, so the triggers below remove links
-- whose target is deleted; the email side cascades normally.
CREATE TABLE inbound_email_links (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  email_id TEXT NOT NULL
    REFERENCES inbound_emails (id) ON DELETE CASCADE,
  target_type TEXT NOT NULL
    CHECK (target_type IN ('library_folder', 'finance_transaction')),
  target_id TEXT NOT NULL,
  created_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (email_id, target_type, target_id)
);

CREATE INDEX inbound_email_links_target_idx
ON inbound_email_links (organization_id, target_type, target_id);

CREATE TRIGGER remove_library_folder_email_links
AFTER DELETE ON library_folders
BEGIN
  DELETE FROM inbound_email_links
  WHERE target_type = 'library_folder' AND target_id = OLD.id;
END;

CREATE TRIGGER remove_finance_transaction_email_links
AFTER DELETE ON plaid_transactions
BEGIN
  DELETE FROM inbound_email_links
  WHERE target_type = 'finance_transaction' AND target_id = OLD.id;
END;
