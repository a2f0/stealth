ALTER TABLE businesses ADD COLUMN incorporation_date TEXT
CHECK (
  incorporation_date IS NULL OR
  incorporation_date GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
);

ALTER TABLE businesses ADD COLUMN street_address TEXT
CHECK (
  street_address IS NULL OR
  (
    length(trim(street_address)) > 0 AND
    length(street_address) <= 240
  )
);
