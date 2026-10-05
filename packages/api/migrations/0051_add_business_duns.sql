ALTER TABLE businesses ADD COLUMN duns TEXT
CHECK (
  duns IS NULL OR
  (length(duns) = 9 AND duns NOT GLOB '*[^0-9]*')
);

CREATE UNIQUE INDEX businesses_organization_duns_idx
ON businesses (organization_id, duns);
