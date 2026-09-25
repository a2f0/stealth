ALTER TABLE businesses ADD COLUMN city TEXT
CHECK (
  city IS NULL OR
  (length(trim(city)) > 0 AND length(city) <= 100)
);

ALTER TABLE businesses ADD COLUMN state TEXT
CHECK (state IS NULL OR state GLOB '[A-Z][A-Z]');

ALTER TABLE businesses ADD COLUMN zip TEXT
CHECK (
  zip IS NULL OR
  zip GLOB '[0-9][0-9][0-9][0-9][0-9]' OR
  zip GLOB '[0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'
);
