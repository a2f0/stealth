CREATE TABLE businesses_with_optional_ein (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  ein TEXT
    CHECK (
      ein IS NULL OR
      (length(ein) = 9 AND ein NOT GLOB '*[^0-9]*')
    ),
  created_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, ein)
);

INSERT INTO businesses_with_optional_ein (
  id,
  organization_id,
  name,
  ein,
  created_by,
  created_at,
  updated_at
)
SELECT
  id,
  organization_id,
  name,
  ein,
  created_by,
  created_at,
  updated_at
FROM businesses;

DROP TABLE businesses;
ALTER TABLE businesses_with_optional_ein RENAME TO businesses;

CREATE INDEX businesses_organization_created_at_idx
ON businesses (organization_id, created_at DESC);
