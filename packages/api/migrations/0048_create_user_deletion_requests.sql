CREATE TABLE user_deletion_requests (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL,
  last_attempted_at TEXT
);
CREATE INDEX user_deletion_requests_requested_at_idx
ON user_deletion_requests(requested_at);
