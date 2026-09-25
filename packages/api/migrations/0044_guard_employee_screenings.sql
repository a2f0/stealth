ALTER TABLE employee_requirements
ADD COLUMN document_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE employee_requirements ADD COLUMN checkr_starting_at TEXT;
ALTER TABLE employee_requirements ADD COLUMN checkr_start_nonce TEXT;
ALTER TABLE employee_requirements ADD COLUMN checkr_start_nonce_at TEXT;
ALTER TABLE employee_requirements
ADD COLUMN checkr_attempt INTEGER NOT NULL DEFAULT 0;
