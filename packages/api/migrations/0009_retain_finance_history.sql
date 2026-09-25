ALTER TABLE plaid_items ADD COLUMN disconnected_at TEXT;

ALTER TABLE plaid_transactions ADD COLUMN pending_transaction_id TEXT;
ALTER TABLE plaid_transactions
ADD COLUMN source_status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE finance_transaction_annotations (
  transaction_id TEXT NOT NULL PRIMARY KEY
    REFERENCES plaid_transactions (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  category_override TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX finance_transaction_annotations_organization_idx
ON finance_transaction_annotations (organization_id, updated_at DESC);

CREATE INDEX plaid_transactions_reconciliation_idx
ON plaid_transactions (
  organization_id,
  account_record_id,
  transaction_date,
  amount
);
