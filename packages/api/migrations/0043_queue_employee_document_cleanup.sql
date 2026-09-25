CREATE TRIGGER queue_employee_document_cleanup
BEFORE DELETE ON employee_requirements
WHEN OLD.document_key IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO deleted_object_cleanup (
    id, organization_id, object_key, deleted_at, cleanup_token,
    cleanup_claimed_at
  ) VALUES (
    'employee-form:' || lower(hex(randomblob(16))),
    OLD.organization_id,
    OLD.document_key,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL
  );
END;

CREATE TRIGGER queue_replaced_employee_document_cleanup
AFTER UPDATE OF document_key ON employee_requirements
WHEN OLD.document_key IS NOT NULL AND OLD.document_key <> NEW.document_key
BEGIN
  INSERT OR REPLACE INTO deleted_object_cleanup (
    id, organization_id, object_key, deleted_at, cleanup_token,
    cleanup_claimed_at
  ) VALUES (
    'employee-form:' || lower(hex(randomblob(16))),
    OLD.organization_id,
    OLD.document_key,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL
  );
END;
