CREATE TRIGGER clear_completed_employee_form_upload
AFTER UPDATE OF document_key ON employee_requirements
WHEN NEW.document_key IS NOT NULL
BEGIN
  DELETE FROM deleted_object_cleanup WHERE object_key = NEW.document_key;
END;
