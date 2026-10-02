CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT REFERENCES organization (id) ON DELETE CASCADE,
  root_type TEXT NOT NULL,
  root_id TEXT NOT NULL,
  root_label TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  actor_name TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details TEXT NOT NULL CHECK (json_valid(details)),
  historical INTEGER NOT NULL DEFAULT 0 CHECK (historical IN (0, 1))
);

CREATE INDEX activity_events_organization_idx
ON activity_events (organization_id, id DESC);
CREATE INDEX activity_events_root_idx
ON activity_events (root_type, root_id, organization_id, id DESC);
CREATE INDEX activity_events_actor_idx ON activity_events (actor_user_id);

ALTER TABLE audits ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audits ADD COLUMN activity_actor_id TEXT REFERENCES user (id) ON DELETE RESTRICT;
ALTER TABLE audit_issues ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audit_issues ADD COLUMN activity_actor_id TEXT REFERENCES user (id) ON DELETE RESTRICT;

-- Only facts already recorded are imported. Past answer edits and the actors
-- behind past completions cannot be recovered from a run's current state.
INSERT INTO activity_events (
  organization_id, root_type, root_id, root_label, subject_type, subject_id,
  action, actor_user_id, actor_name, actor_email, occurred_at, details, historical
)
SELECT history.organization_id, history.root_type, history.root_id,
       history.root_label, history.subject_type, history.subject_id,
       history.action, actor.id, actor.name, actor.email,
       history.occurred_at, history.details, 1
FROM (
  SELECT family.organization_id, 'audit_template' AS root_type,
         family.id AS root_id, version.name AS root_label,
         'audit_template' AS subject_type, family.id AS subject_id,
         CASE WHEN version.version = 1 THEN 'audit.template_created'
              ELSE 'audit.template_version_saved' END AS action,
         CASE WHEN version.version = 1 THEN family.created_by
              ELSE version.created_by END AS actor_id,
         CASE WHEN version.version = 1 THEN family.created_at
              ELSE version.created_at END AS occurred_at,
         json_object('version', version.version) AS details
  FROM audit_template_versions AS version
  JOIN audit_template_families AS family ON family.id = version.template_id
  UNION ALL
  SELECT organization_id, 'audit_run', id, template_name, 'audit_run', id,
         'audit.started', started_by, created_at,
         json_object('templateVersion', template_version)
  FROM audits
  UNION ALL
  SELECT issue.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue', issue.id, 'audit.issue_created', issue.created_by,
         issue.created_at,
         json_object('title', issue.title, 'itemId', issue.item_id,
                     'description', issue.description, 'priority', issue.priority)
  FROM audit_issues AS issue
  JOIN audits AS audit ON audit.id = issue.audit_id
  UNION ALL
  SELECT issue.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue_image', image.id, 'audit.image_uploaded', image.uploaded_by,
         image.created_at,
         json_object('filename', object.filename, 'issueId', issue.id, 'title', issue.title)
  FROM audit_issue_images AS image
  JOIN audit_issues AS issue ON issue.id = image.issue_id
  JOIN audits AS audit ON audit.id = issue.audit_id
  JOIN objects AS object ON object.id = image.object_id
  WHERE object.deletion_pending = 0
) AS history
JOIN user AS actor ON actor.id = history.actor_id
ORDER BY history.occurred_at, history.root_id, history.subject_id;

-- Triggers keep each activity write in the transaction that changes the data.
CREATE TRIGGER activity_template_version_insert
AFTER INSERT ON audit_template_versions
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT family.organization_id, 'audit_template', family.id, NEW.name,
         'audit_template', family.id,
         CASE WHEN NEW.version = 1 THEN 'audit.template_created'
              ELSE 'audit.template_version_saved' END,
         actor.id, actor.name, actor.email, NEW.created_at,
         json_object('version', NEW.version)
  FROM audit_template_families AS family
  JOIN user AS actor ON actor.id = NEW.created_by
  WHERE family.id = NEW.template_id;
END;

CREATE TRIGGER activity_audit_insert AFTER INSERT ON audits
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', NEW.id, NEW.template_name,
         'audit_run', NEW.id, 'audit.started', actor.id, actor.name, actor.email,
         NEW.created_at, json_object('templateVersion', NEW.template_version)
  FROM user AS actor WHERE actor.id = NEW.started_by;
END;

CREATE TRIGGER activity_audit_update AFTER UPDATE ON audits
WHEN NEW.revision <> OLD.revision AND NEW.activity_actor_id IS NOT NULL
  AND (NEW.responses <> OLD.responses OR NEW.status <> OLD.status)
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', NEW.id, NEW.template_name,
         'audit_answer', item.value ->> '$.id', 'audit.answer_changed',
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('prompt', item.value ->> '$.prompt',
                     'responseType', item.value ->> '$.responseType',
                     'before', previous.value, 'after', current.value)
  FROM json_each(NEW.definition, '$.sections') AS section
  JOIN json_each(section.value, '$.items') AS item
  LEFT JOIN (
    SELECT key, MAX(value) AS value FROM json_each(OLD.responses) GROUP BY key
  ) AS previous ON previous.key = item.value ->> '$.id'
  LEFT JOIN (
    SELECT key, MAX(value) AS value FROM json_each(NEW.responses) GROUP BY key
  ) AS current ON current.key = item.value ->> '$.id'
  JOIN user AS actor ON actor.id = NEW.activity_actor_id
  WHERE NEW.responses <> OLD.responses AND previous.value IS NOT current.value;

  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', NEW.id, NEW.template_name,
         'audit_run', NEW.id,
         CASE WHEN NEW.status = 'completed' THEN 'audit.completed' ELSE 'audit.reopened' END,
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('before', OLD.status, 'after', NEW.status)
  FROM user AS actor
  WHERE actor.id = NEW.activity_actor_id AND NEW.status <> OLD.status;
END;

CREATE TRIGGER activity_issue_insert AFTER INSERT ON audit_issues
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue', NEW.id, 'audit.issue_created', actor.id, actor.name, actor.email,
         NEW.created_at,
         json_object('title', NEW.title, 'itemId', NEW.item_id,
                     'description', NEW.description, 'priority', NEW.priority,
                     'assignedTo', NEW.assigned_to,
                     'assigneeName', assignee.name, 'assigneeEmail', assignee.email)
  FROM audits AS audit
  JOIN user AS actor ON actor.id = NEW.created_by
  LEFT JOIN user AS assignee ON assignee.id = NEW.assigned_to
  WHERE audit.id = NEW.audit_id;
END;

-- Foreign-key unassignment and other maintenance do not increment revision;
-- they must never be attributed to the last person who edited an issue.
CREATE TRIGGER activity_issue_update AFTER UPDATE ON audit_issues
WHEN NEW.revision <> OLD.revision AND NEW.activity_actor_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue', NEW.id,
         CASE WHEN NEW.status = 'resolved' THEN 'audit.issue_resolved' ELSE 'audit.issue_reopened' END,
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('title', NEW.title, 'before', OLD.status, 'after', NEW.status)
  FROM audits AS audit
  JOIN user AS actor ON actor.id = NEW.activity_actor_id
  WHERE audit.id = NEW.audit_id AND NEW.status <> OLD.status;

  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue', NEW.id, 'audit.issue_assigned',
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('title', NEW.title, 'before', OLD.assigned_to, 'after', NEW.assigned_to,
                     'beforeName', previous.name, 'beforeEmail', previous.email,
                     'afterName', current.name, 'afterEmail', current.email)
  FROM audits AS audit
  JOIN user AS actor ON actor.id = NEW.activity_actor_id
  LEFT JOIN user AS previous ON previous.id = OLD.assigned_to
  LEFT JOIN user AS current ON current.id = NEW.assigned_to
  WHERE audit.id = NEW.audit_id AND NEW.assigned_to IS NOT OLD.assigned_to;
END;

-- Reservations and failed uploads are not activity. Only activation is.
CREATE TRIGGER activity_issue_image_activate AFTER UPDATE ON objects
WHEN NEW.kind = 'audit_issue_image' AND OLD.deletion_pending = 1 AND NEW.deletion_pending = 0
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT issue.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue_image', image.id, 'audit.image_uploaded', actor.id, actor.name, actor.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('filename', NEW.filename, 'issueId', issue.id, 'title', issue.title)
  FROM audit_issue_images AS image
  JOIN audit_issues AS issue ON issue.id = image.issue_id
  JOIN audits AS audit ON audit.id = issue.audit_id
  JOIN user AS actor ON actor.id = image.uploaded_by
  WHERE image.object_id = NEW.id;
END;

-- Activity follows the same lifetime as its root, including Free-plan run
-- retention and organization purges. Removing an image preserves its history.
CREATE TRIGGER activity_audit_delete AFTER DELETE ON audits
BEGIN
  DELETE FROM activity_events WHERE root_type = 'audit_run' AND root_id = OLD.id;
END;
CREATE TRIGGER activity_template_delete AFTER DELETE ON audit_template_families
BEGIN
  DELETE FROM activity_events WHERE root_type = 'audit_template' AND root_id = OLD.id;
END;
