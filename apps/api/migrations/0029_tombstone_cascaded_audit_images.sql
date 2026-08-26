CREATE TRIGGER tombstone_cascaded_audit_issue_image
BEFORE DELETE ON audit_issue_images
WHEN EXISTS (
  SELECT 1
  FROM objects
  WHERE id = OLD.object_id
    AND kind = 'audit_issue_image'
    AND deletion_pending = 0
)
BEGIN
  UPDATE objects
  SET deletion_pending = 1,
      cleanup_token = NULL,
      cleanup_claimed_at = NULL,
      upload_token = NULL,
      upload_lease_expires_at = NULL
  WHERE id = OLD.object_id
    AND kind = 'audit_issue_image';
END;
