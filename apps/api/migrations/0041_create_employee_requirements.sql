-- Onboarding requirements belong to a pending invitation until it is accepted,
-- then to the resulting organization membership. Documents are private R2 objects.
CREATE TABLE employee_requirements (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  invitation_id TEXT REFERENCES invitation (id) ON DELETE CASCADE,
  member_id TEXT REFERENCES member (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('form', 'background_check', 'credit_check')),
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'submitted', 'complete')),
  document_key TEXT UNIQUE,
  document_filename TEXT,
  document_size INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (invitation_id IS NOT NULL OR member_id IS NOT NULL)
);

CREATE INDEX employee_requirements_member_idx
ON employee_requirements (organization_id, member_id, due_date);
CREATE INDEX employee_requirements_invitation_idx
ON employee_requirements (organization_id, invitation_id);
