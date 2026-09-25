ALTER TABLE objects
ADD COLUMN deletion_pending INTEGER NOT NULL DEFAULT 0
CHECK (deletion_pending IN (0, 1));
