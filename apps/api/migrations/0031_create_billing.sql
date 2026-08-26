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
  updated_at TEXT NOT NULL
);

CREATE INDEX organization_billing_status_idx
ON organization_billing (stripe_status, updated_at);

CREATE TABLE stripe_webhook_events (
  id TEXT NOT NULL PRIMARY KEY,
  event_type TEXT NOT NULL,
  stripe_created INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX stripe_webhook_events_processing_idx
ON stripe_webhook_events (processed_at, received_at);
