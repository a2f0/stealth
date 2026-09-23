-- Organization equipment. The API owns the list of types, so a new type
-- needs no table rebuild.
CREATE TABLE equipment (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  serial_number TEXT,
  purchase_date TEXT,
  assigned_user_id TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX equipment_organization_created_at_idx
ON equipment (organization_id, created_at DESC);

CREATE INDEX equipment_assigned_user_idx
ON equipment (assigned_user_id);

-- Equipment stays assigned only to current members: leaving or being removed
-- from the organization returns a member's equipment to unassigned.
CREATE TRIGGER unassign_equipment_on_member_removal
AFTER DELETE ON member
BEGIN
  UPDATE equipment
  SET assigned_user_id = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE organization_id = OLD.organizationId
    AND assigned_user_id = OLD.userId;
END;
