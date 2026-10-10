import {
  type AuditDefinition,
  isRecord,
  parseAuditDefinition,
  validText,
} from "./auditDefinition";
import { nfpa70eStarter } from "./nfpa70eStarter";
import { residentialCoreStarter } from "./residentialAuditLibrary";

export interface TemplateRow {
  created_at: string;
  current_version: number;
  definition: string;
  description: string;
  id: string;
  name: string;
  scope: "global" | "organization";
  status: string;
  updated_at: string;
  version: number;
  version_created_at: string;
  version_created_by_email: string;
  version_created_by_id: string;
  version_created_by_name: string;
  version_id: string;
}

interface TemplateVersionRow {
  created_at: string;
  created_by_email: string;
  created_by_id: string;
  created_by_name: string;
  version: number;
}

export interface TemplateSaveInput {
  definition: AuditDefinition;
  description: string;
  expectedCurrentVersion: unknown;
  name: string;
}

const templateColumns = `
  family.id,
  family.scope,
  family.current_version,
  family.created_at,
  family.updated_at,
  version.id AS version_id,
  version.version,
  version.name,
  version.description,
  version.definition,
  version.status,
  version.created_at AS version_created_at,
  version.created_by AS version_created_by_id,
  creator.name AS version_created_by_name,
  creator.email AS version_created_by_email`;

export const templateSelect = `
  SELECT ${templateColumns}
  FROM audit_template_families AS family
  JOIN audit_template_versions AS version
    ON version.template_id = family.id
   AND version.version = family.current_version
  JOIN user AS creator ON creator.id = version.created_by`;

export const staleTemplateError =
  "This template has a newer version. Reload it before saving.";

const auditLibraryActor = {
  email: "audit-library@system.invalid",
  id: "system:audit-library",
  name: "Stealth audit library",
} as const;

/**
 * Creates a blank template at version one: an organization's, when the
 * organization is still under its template limit, or a global one when no
 * organization is given. Returns null when the limit is reached.
 */
export async function createTemplate(
  database: D1Database,
  input: {
    name: string;
    organizationId: string | null;
    templateLimit: number | null;
    userId: string;
  },
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO audit_template_families
         (id, scope, organization_id, current_version, created_by, created_at,
          updated_at)
         SELECT ?, ?, ?, 1, ?, ?, ?
         WHERE ? IS NULL OR (
           SELECT COUNT(*) FROM audit_template_families
           WHERE scope = 'organization' AND organization_id = ?
         ) < ?`,
      )
      .bind(
        id,
        input.organizationId ? "organization" : "global",
        input.organizationId,
        input.userId,
        now,
        now,
        input.templateLimit,
        input.organizationId,
        input.templateLimit,
      ),
    database
      .prepare(
        `INSERT INTO audit_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at)
         SELECT ?, ?, 1, ?, '', ?, 'draft', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM audit_template_families WHERE id = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        id,
        input.name,
        JSON.stringify(blankDefinition()),
        input.userId,
        now,
        id,
      ),
  ]);
  if (Number(results[0]?.meta.changes) !== 1) return null;
  const template = await findTemplate(database, input.organizationId, id);
  if (!template) throw new Error("Created template could not be loaded.");
  return template;
}

/**
 * Saves the input as the template's next version. Returns "stale" when the
 * input was edited from an older version or another save won the race.
 */
export async function saveTemplateVersion(
  database: D1Database,
  organizationId: string | null,
  current: TemplateRow,
  userId: string,
  input: TemplateSaveInput,
) {
  if (
    input.expectedCurrentVersion !== undefined &&
    input.expectedCurrentVersion !== current.current_version
  ) {
    return "stale" as const;
  }
  try {
    await addTemplateVersion(
      database,
      current,
      userId,
      input,
      new Date().toISOString(),
    );
  } catch (cause) {
    const latest = await findTemplate(database, organizationId, current.id);
    if (latest && latest.current_version !== current.current_version) {
      return "stale" as const;
    }
    throw cause;
  }
  const saved = await findTemplate(database, organizationId, current.id);
  if (!saved) throw new Error("Saved template could not be loaded.");
  return saved;
}

async function addTemplateVersion(
  database: D1Database,
  current: TemplateRow,
  userId: string,
  input: TemplateSaveInput,
  now: string,
) {
  const version = current.current_version + 1;
  await database.batch([
    database
      .prepare(
        `UPDATE audit_template_families
         SET current_version = ?, updated_at = ?
         WHERE id = ? AND current_version = ?`,
      )
      .bind(version, now, current.id, current.current_version),
    database
      .prepare(
        `INSERT INTO audit_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        current.id,
        version,
        input.name,
        input.description,
        JSON.stringify(input.definition),
        current.status,
        userId,
        now,
      ),
  ]);
}

export async function listTemplateVersions(
  database: D1Database,
  templateId: string,
) {
  const result = await database
    .prepare(
      `SELECT version.version, version.created_at,
              version.created_by AS created_by_id,
              creator.name AS created_by_name,
              creator.email AS created_by_email
       FROM audit_template_versions AS version
       JOIN user AS creator ON creator.id = version.created_by
       WHERE version.template_id = ?
       ORDER BY version.version DESC`,
    )
    .bind(templateId)
    .all<TemplateVersionRow>();
  return result.results.map(toTemplateVersion);
}

export async function ensureStarterTemplates(database: D1Database) {
  const starters = [
    { id: "nfpa70e_global", ...nfpa70eStarter },
    residentialCoreStarter,
  ];
  const seeded = await database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM audit_template_families AS family
       JOIN audit_template_versions AS version
         ON version.template_id = family.id AND version.version = 1
       WHERE family.id IN (?, ?)`,
    )
    .bind(...starters.map(({ id }) => id))
    .first<{ count: number }>();
  if (Number(seeded?.count) === starters.length) return;

  const now = new Date().toISOString();
  await database.batch(
    starters.flatMap((starter) => [
      database
        .prepare(
          `INSERT OR IGNORE INTO audit_template_families
           (id, scope, organization_id, current_version, created_by,
            created_at, updated_at)
           VALUES (?, 'global', NULL, 1, ?, ?, ?)`,
        )
        .bind(starter.id, auditLibraryActor.id, now, now),
      database
        .prepare(
          `INSERT OR IGNORE INTO audit_template_versions
           (id, template_id, version, name, description, definition, status,
            created_by, created_at)
           VALUES (?, ?, 1, ?, ?, ?, 'published', ?, ?)`,
        )
        .bind(
          `${starter.id}:v1`,
          starter.id,
          starter.name,
          starter.description,
          JSON.stringify(starter.definition),
          auditLibraryActor.id,
          now,
        ),
    ]),
  );
}

/**
 * A global template, or one of the organization's own. With no organization,
 * only global templates match.
 */
export async function findTemplate(
  database: D1Database,
  organizationId: string | null,
  id: string,
  version?: number,
) {
  await ensureStarterTemplates(database);
  const versionJoin = version
    ? "version.version = ?"
    : "version.version = family.current_version";
  const statement = database.prepare(
    `SELECT ${templateColumns}
     FROM audit_template_families AS family
     JOIN audit_template_versions AS version
       ON version.template_id = family.id AND ${versionJoin}
     JOIN user AS creator ON creator.id = version.created_by
     WHERE family.id = ?
       AND (family.scope = 'global' OR family.organization_id = ?)`,
  );
  return version
    ? statement.bind(version, id, organizationId).first<TemplateRow>()
    : statement.bind(id, organizationId).first<TemplateRow>();
}

export function templateSaveInput(value: unknown): TemplateSaveInput | string {
  if (!isRecord(value) || !validText(value.name, 200)) {
    return "A template name is required.";
  }
  const definition = parseAuditDefinition(value.definition);
  if (!definition) return "The template definition is invalid.";
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  if (description.length > 2_000) {
    return "Descriptions are limited to 2,000 characters.";
  }
  return {
    definition,
    description,
    expectedCurrentVersion: value.expectedCurrentVersion,
    name: value.name.trim(),
  };
}

export function positiveInteger(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function blankDefinition(): AuditDefinition {
  return {
    sections: [
      {
        id: crypto.randomUUID(),
        items: [
          {
            id: crypto.randomUUID(),
            prompt: "Untitled question",
            required: true,
            responseType: "check",
          },
        ],
        title: "Untitled section",
      },
    ],
    version: 1,
  };
}

export function storedDefinition(value: string) {
  const definition = parseAuditDefinition(JSON.parse(value));
  if (!definition) throw new Error("Stored audit definition is invalid.");
  return definition;
}

export function toTemplate(row: TemplateRow) {
  return {
    createdAt: row.created_at,
    currentVersion: row.current_version,
    definition: storedDefinition(row.definition),
    description: row.description,
    id: row.id,
    name: row.name,
    savedAt: row.version_created_at,
    savedBy: templateActor(
      row.version_created_by_id,
      row.version_created_by_name,
      row.version_created_by_email,
    ),
    scope: row.scope,
    status: row.status,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function toTemplateVersion(row: TemplateVersionRow) {
  return {
    createdAt: row.created_at,
    createdBy: templateActor(
      row.created_by_id,
      row.created_by_name,
      row.created_by_email,
    ),
    version: row.version,
  };
}

function templateActor(id: string, name: string, email: string) {
  return id === auditLibraryActor.id ? auditLibraryActor : { email, id, name };
}
