CREATE TABLE organization_billing (
  organization_id TEXT NOT NULL PRIMARY KEY
    REFERENCES organization (id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_subscription_item_id TEXT,
  stripe_price_id TEXT,
  stripe_status TEXT,
  seat_quantity INTEGER NOT NULL DEFAULT 1 CHECK (seat_quantity > 0),
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0
    CHECK (cancel_at_period_end IN (0, 1)),
  current_period_end TEXT,
  stripe_event_created INTEGER NOT NULL DEFAULT 0,
  checkout_claim_id TEXT,
  checkout_claim_quantity INTEGER CHECK (checkout_claim_quantity > 0),
  checkout_claim_expires_at INTEGER,
  checkout_disabled_at TEXT,
  checkout_disabled_expires_at INTEGER,
  pending_checkout_session_id TEXT UNIQUE,
  pending_checkout_url TEXT,
  pending_checkout_expires_at INTEGER,
  last_reconciled_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX organization_billing_status_idx
ON organization_billing (stripe_status, last_reconciled_at);

CREATE TABLE stripe_subscription_sync_locks (
  subscription_id TEXT NOT NULL PRIMARY KEY,
  claim_id TEXT NOT NULL,
  claim_expires_at INTEGER NOT NULL
);

CREATE TABLE stripe_webhook_events (
  id TEXT NOT NULL PRIMARY KEY,
  event_type TEXT NOT NULL,
  stripe_created INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX stripe_webhook_events_processing_idx
ON stripe_webhook_events (processed_at, received_at);

CREATE TRIGGER organization_after_restore_billing
AFTER UPDATE OF deletedAt ON organization
WHEN OLD.deletedAt IS NOT NULL AND NEW.deletedAt IS NULL
BEGIN
  UPDATE organization_billing
  SET checkout_disabled_at = NULL,
      checkout_disabled_expires_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE organization_id = NEW.id;
END;
