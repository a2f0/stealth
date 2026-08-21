CREATE TABLE businesses (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  ein TEXT NOT NULL
    CHECK (length(ein) = 9 AND ein NOT GLOB '*[^0-9]*'),
  created_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, ein)
);

CREATE INDEX businesses_organization_created_at_idx
ON businesses (organization_id, created_at DESC);
