CREATE TABLE plaid_items (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  plaid_item_id TEXT NOT NULL UNIQUE,
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  institution_id TEXT,
  institution_name TEXT,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  error_code TEXT,
  last_synced_at TEXT,
  created_by TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE plaid_accounts (
  id TEXT NOT NULL PRIMARY KEY,
  plaid_account_id TEXT NOT NULL,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  plaid_item_record_id TEXT NOT NULL
    REFERENCES plaid_items (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  official_name TEXT,
  mask TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  current_balance REAL,
  available_balance REAL,
  currency_code TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (plaid_item_record_id, plaid_account_id)
);

CREATE TABLE plaid_transactions (
  id TEXT NOT NULL PRIMARY KEY,
  plaid_transaction_id TEXT NOT NULL,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  plaid_item_record_id TEXT NOT NULL
    REFERENCES plaid_items (id) ON DELETE CASCADE,
  account_record_id TEXT NOT NULL
    REFERENCES plaid_accounts (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  merchant_name TEXT,
  amount REAL NOT NULL,
  currency_code TEXT,
  transaction_date TEXT NOT NULL,
  authorized_date TEXT,
  category_primary TEXT,
  category_detailed TEXT,
  payment_channel TEXT,
  pending INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plaid_item_record_id, plaid_transaction_id)
);

CREATE INDEX plaid_items_organization_idx
ON plaid_items (organization_id, updated_at DESC);
CREATE INDEX plaid_accounts_organization_idx
ON plaid_accounts (organization_id, name);
CREATE INDEX plaid_transactions_organization_date_idx
ON plaid_transactions (organization_id, transaction_date DESC);
CREATE INDEX plaid_transactions_item_idx
ON plaid_transactions (plaid_item_record_id);
