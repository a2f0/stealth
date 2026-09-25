INSERT INTO "user" (
  "id",
  "name",
  "email",
  "emailVerified",
  "createdAt",
  "updatedAt",
  "role",
  "banned",
  "banReason"
)
VALUES (
  'system:audit-library',
  'Stealth audit library',
  'audit-library+' || lower(hex(randomblob(16))) || '@system.invalid',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'system',
  1,
  'Reserved application actor for built-in audit templates.'
);

UPDATE audit_template_families
SET created_by = 'system:audit-library'
WHERE scope = 'global'
  AND id IN ('nfpa70e_global', 'us_residential_core_global');

UPDATE audit_template_versions
SET created_by = 'system:audit-library'
WHERE version = 1
  AND template_id IN ('nfpa70e_global', 'us_residential_core_global');
