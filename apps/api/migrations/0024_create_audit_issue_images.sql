CREATE TABLE audit_issue_images (
  id TEXT NOT NULL PRIMARY KEY,
  issue_id TEXT NOT NULL
    REFERENCES audit_issues (id) ON DELETE CASCADE,
  object_id TEXT NOT NULL UNIQUE
    REFERENCES objects (id) ON DELETE CASCADE,
  uploaded_by TEXT NOT NULL
    REFERENCES user (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_issue_images_issue_idx
ON audit_issue_images (issue_id, created_at);
