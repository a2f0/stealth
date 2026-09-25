INSERT OR IGNORE INTO audit_template_families (
  id,
  scope,
  organization_id,
  current_version,
  created_by,
  created_at,
  updated_at
)
SELECT
  'nfpa70e_global',
  'global',
  NULL,
  1,
  family.created_by,
  family.created_at,
  family.updated_at
FROM audit_template_families AS family
WHERE family.id GLOB 'nfpa70e_*'
  AND family.id <> 'nfpa70e_global'
  AND family.current_version = 1
ORDER BY family.created_at, family.id
LIMIT 1;

INSERT OR IGNORE INTO audit_template_versions (
  id,
  template_id,
  version,
  name,
  description,
  definition,
  status,
  created_by,
  created_at
)
SELECT
  'nfpa70e_global:v1',
  'nfpa70e_global',
  1,
  version.name,
  version.description,
  version.definition,
  version.status,
  version.created_by,
  version.created_at
FROM audit_template_families AS family
JOIN audit_template_versions AS version
  ON version.template_id = family.id
 AND version.version = 1
WHERE family.id GLOB 'nfpa70e_*'
  AND family.id <> 'nfpa70e_global'
  AND family.current_version = 1
ORDER BY family.created_at, family.id
LIMIT 1;

UPDATE audits
SET
  template_family_id = 'nfpa70e_global',
  template_version_id = 'nfpa70e_global:v1',
  template_version = 1
WHERE template_family_id IN (
  SELECT id
  FROM audit_template_families
  WHERE id GLOB 'nfpa70e_*'
    AND id <> 'nfpa70e_global'
    AND current_version = 1
)
AND EXISTS (
  SELECT 1
  FROM audit_template_versions
  WHERE id = 'nfpa70e_global:v1'
);

DELETE FROM audit_template_families
WHERE id GLOB 'nfpa70e_*'
  AND id <> 'nfpa70e_global'
  AND current_version = 1
  AND EXISTS (
    SELECT 1
    FROM audit_template_versions
    WHERE id = 'nfpa70e_global:v1'
  );
