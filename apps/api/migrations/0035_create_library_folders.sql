CREATE TABLE library_folders (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX library_folders_name_idx
ON library_folders (organization_id, name COLLATE NOCASE);

-- A library document lives in at most one folder: a single nullable
-- reference on its object. Deleting a folder returns its documents to the
-- library root.
ALTER TABLE objects
ADD COLUMN folder_id TEXT
  REFERENCES library_folders (id) ON DELETE SET NULL;

CREATE INDEX objects_organization_folder_created_at_idx
ON objects (organization_id, kind, folder_id, created_at DESC);
