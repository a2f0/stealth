ALTER TABLE organization_billing ADD COLUMN paid_ended_at TEXT;

-- Rows that already lost paid status start their grace period now, so no
-- lapsed organization is purged sooner than the grace period allows.
UPDATE organization_billing
SET paid_ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE stripe_status IS NOT NULL
  AND stripe_status NOT IN ('active', 'past_due', 'trialing');
