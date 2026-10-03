import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { draftStatements } from "./contractDraft";
import { InvalidPdfError, inspectPdf, sha256Hex } from "./contractPdf";
import { eventStatement } from "./contractRecords";
import {
  mappedDraft,
  type TemplateDefinition,
  templateInput,
} from "./contractTemplateDefinition";
import { normalizeFilename } from "./filenames";
import type { Bindings } from "./types";

type TemplateEnv = { Bindings: Bindings; Variables: AuthVariables };
type TemplateContext = Context<TemplateEnv>;
interface VersionRow {
  created_at: string;
  created_by_name: string | null;
  current_version: number;
  definition_json: string;
  description: string;
  document_filename: string;
  document_object_key: string;
  document_page_count: number;
  document_sha256: string;
  document_size: number;
  id: string;
  name: string;
  template_id: string;
  version: number;
}
interface DocumentInput {
  bytes: Uint8Array;
  filename: string;
  pageCount: number;
  sha256: string;
}

const contractTemplates = new Hono<TemplateEnv>();

contractTemplates.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT family.id, version.name, version.description,
            family.current_version AS currentVersion, family.updated_at AS updatedAt
     FROM contract_templates AS family
     JOIN contract_template_versions AS version
       ON version.template_id = family.id AND version.version = family.current_version
     WHERE family.organization_id = ?
     ORDER BY family.updated_at DESC, family.id DESC`,
  )
    .bind(context.get("organizationId"))
    .all();
  return context.json({ templates: result.results });
});

contractTemplates.post("/", async (context) => {
  const form = (await context.req.parseBody()) as { file?: File | string };
  const document = await readDocument(form.file);
  if (typeof document === "string")
    return context.json({ error: document }, 400);
  const organizationId = context.get("organizationId");
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const objectKey = `organizations/${organizationId}/contract-templates/${id}/${versionId}.pdf`;
  const definition: TemplateDefinition = {
    fields: [],
    message: "",
    reminderIntervalDays: null,
    roles: [{ key: crypto.randomUUID(), label: "Signer", routingOrder: 1 }],
    signingOrder: "parallel",
  };
  await storeDocument(context, objectKey, document);
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO contract_templates (id, organization_id, current_version, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      ).bind(id, organizationId, now, now),
      context.env.DB.prepare(
        `INSERT INTO contract_template_versions
          (id, template_id, version, name, definition_json, document_object_key,
           document_filename, document_size, document_sha256, document_page_count, created_by, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        versionId,
        id,
        document.filename.replace(/\.pdf$/i, "").slice(0, 200) ||
          "Contract template",
        JSON.stringify(definition),
        objectKey,
        document.filename,
        document.bytes.byteLength,
        document.sha256,
        document.pageCount,
        context.get("authSession").user.id,
        now,
      ),
    ]);
  } catch (cause) {
    await context.env.STORAGE.delete(objectKey);
    throw cause;
  }
  return context.json(
    { template: toDetail(await findVersion(context, id)) },
    201,
  );
});

contractTemplates.get("/:id", async (context) => {
  const selected = context.req.query("version");
  if (selected !== undefined && !positiveInteger(selected))
    return context.json({ error: "Choose a template version." }, 400);
  const version = await findVersion(
    context,
    context.req.param("id"),
    selected ? Number(selected) : undefined,
  );
  if (!version) return notFound(context);
  return context.json({ template: toDetail(version) });
});

contractTemplates.get("/:id/versions", async (context) => {
  if (!(await findVersion(context, context.req.param("id"))))
    return notFound(context);
  const result = await context.env.DB.prepare(
    `SELECT version.version, version.name, version.created_at AS createdAt,
            creator.name AS createdByName
     FROM contract_template_versions AS version
     JOIN contract_templates AS family ON family.id = version.template_id
     LEFT JOIN user AS creator ON creator.id = version.created_by
     WHERE family.id = ? AND family.organization_id = ? ORDER BY version.version DESC`,
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .all();
  return context.json({ versions: result.results });
});

contractTemplates.get("/:id/document", async (context) => {
  const selected = context.req.query("version");
  if (selected !== undefined && !positiveInteger(selected))
    return context.json({ error: "Choose a template version." }, 400);
  const version = await findVersion(
    context,
    context.req.param("id"),
    selected ? Number(selected) : undefined,
  );
  if (!version) return notFound(context);
  const object = await context.env.STORAGE.get(version.document_object_key);
  if (!object)
    return context.json({ error: "The document file is missing." }, 404);
  const filename = encodeURIComponent(version.document_filename).replaceAll(
    "'",
    "%27",
  );
  return new Response(object.body, {
    headers: {
      "content-disposition": `attachment; filename="contract.pdf"; filename*=UTF-8''${filename}`,
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
    },
  });
});

// Saving always appends a version, and guards against overwriting a newer save.
contractTemplates.post("/:id/versions", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (!body || typeof body !== "object")
    return context.json({ error: "The template is invalid." }, 400);
  const sourceVersion = Reflect.get(body, "sourceVersion");
  const expected = Reflect.get(body, "expectedCurrentVersion");
  if (
    !Number.isSafeInteger(sourceVersion) ||
    sourceVersion < 1 ||
    !Number.isSafeInteger(expected) ||
    expected < 1
  )
    return context.json({ error: "Choose a template version." }, 400);
  const source = await findVersion(
    context,
    context.req.param("id"),
    sourceVersion,
  );
  if (!source) return notFound(context);
  const input = templateInput(body, source.document_page_count);
  if (typeof input === "string") return context.json({ error: input }, 400);
  const now = new Date().toISOString();
  const saved = await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO contract_template_versions
        (id, template_id, version, name, description, definition_json, document_object_key,
         document_filename, document_size, document_sha256, document_page_count, created_by, created_at)
       SELECT ?, family.id, ?, ?, ?, ?, source.document_object_key,
         source.document_filename, source.document_size, source.document_sha256, source.document_page_count, ?, ?
       FROM contract_templates AS family
       JOIN contract_template_versions AS source ON source.template_id = family.id AND source.version = ?
       WHERE family.id = ? AND family.organization_id = ? AND family.current_version = ?`,
    ).bind(
      crypto.randomUUID(),
      expected + 1,
      input.name,
      input.description,
      JSON.stringify(input.definition),
      context.get("authSession").user.id,
      now,
      sourceVersion,
      source.template_id,
      context.get("organizationId"),
      expected,
    ),
    context.env.DB.prepare(
      `UPDATE contract_templates SET current_version = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND current_version = ?`,
    ).bind(
      expected + 1,
      now,
      source.template_id,
      context.get("organizationId"),
      expected,
    ),
  ]);
  if (saved[0]?.meta.changes !== 1)
    return context.json(
      {
        error:
          "This template changed. Reload the latest version before saving your changes.",
      },
      409,
    );
  return context.json(
    {
      template: toDetail(
        await findVersion(context, source.template_id, expected + 1),
      ),
    },
    201,
  );
});

contractTemplates.post("/:id/contracts", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  const selected =
    body && typeof body === "object" ? Reflect.get(body, "version") : undefined;
  if (!Number.isSafeInteger(selected) || selected < 1)
    return context.json({ error: "Choose a template version." }, 400);
  const source = await findVersion(context, context.req.param("id"), selected);
  if (!source) return notFound(context);
  const definition = JSON.parse(source.definition_json) as TemplateDefinition;
  const draft = mappedDraft(
    body,
    source.name,
    definition,
    source.document_page_count,
  );
  if (typeof draft === "string") return context.json({ error: draft }, 400);
  const object = await context.env.STORAGE.get(source.document_object_key);
  if (!object)
    return context.json({ error: "The template document is missing." }, 404);
  const organizationId = context.get("organizationId");
  const id = crypto.randomUUID();
  const objectKey = `organizations/${organizationId}/contracts/${id}/original.pdf`;
  const now = new Date().toISOString();
  await context.env.STORAGE.put(objectKey, await object.arrayBuffer(), {
    customMetadata: { contractId: id, organizationId },
    httpMetadata: { contentType: "application/pdf" },
  });
  try {
    const result = await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO contracts
          (id, organization_id, title, document_object_key, document_filename, document_size,
           document_sha256, document_page_count, created_by, created_at, updated_at,
           template_version_id, template_name, template_version)
         SELECT ?, ?, ?, ?, document_filename, document_size, document_sha256,
           document_page_count, ?, ?, ?, id, name, version
         FROM contract_template_versions WHERE id = ?`,
      ).bind(
        id,
        organizationId,
        draft.title,
        objectKey,
        context.get("authSession").user.id,
        now,
        now,
        source.id,
      ),
      ...draftStatements(
        context.env.DB,
        { id, organization_id: organizationId },
        draft,
        now,
      ),
      eventStatement(
        context.env.DB,
        {
          actorUserId: context.get("authSession").user.id,
          contractId: id,
          detail: `${source.name} · v${source.version}`,
          type: "created_from_template",
        },
        {
          sql: "EXISTS (SELECT 1 FROM contracts WHERE id = ?)",
          bindings: [id],
        },
      ),
    ]);
    if (result[0]?.meta.changes !== 1) {
      await context.env.STORAGE.delete(objectKey);
      return notFound(context);
    }
  } catch (cause) {
    await context.env.STORAGE.delete(objectKey);
    throw cause;
  }
  return context.json({ contractId: id }, 201);
});

contractTemplates.delete("/:id", async (context) => {
  const result = await context.env.DB.prepare(
    "DELETE FROM contract_templates WHERE id = ? AND organization_id = ?",
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .run();
  if (!result.meta.changes) return notFound(context);
  return context.body(null, 204);
});

function findVersion(context: TemplateContext, id: string, version?: number) {
  return context.env.DB.prepare(
    `SELECT version.*, family.current_version, creator.name AS created_by_name
     FROM contract_templates AS family
     JOIN contract_template_versions AS version ON version.template_id = family.id
     LEFT JOIN user AS creator ON creator.id = version.created_by
     WHERE family.id = ? AND family.organization_id = ?
       AND version.version = COALESCE(?, family.current_version)`,
  )
    .bind(id, context.get("organizationId"), version ?? null)
    .first<VersionRow>();
}

function toDetail(row: VersionRow | null) {
  if (!row) return null;
  return {
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    currentVersion: row.current_version,
    definition: JSON.parse(row.definition_json) as TemplateDefinition,
    description: row.description,
    document: {
      filename: row.document_filename,
      pageCount: row.document_page_count,
      sha256: row.document_sha256,
      size: row.document_size,
    },
    id: row.template_id,
    name: row.name,
    version: row.version,
  };
}

async function readDocument(file: unknown): Promise<DocumentInput | string> {
  if (!(file instanceof File)) return "Choose a PDF to upload.";
  if (file.size > 10 * 1024 * 1024)
    return "Contract templates must be 10 MB or smaller.";
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const { pageCount } = await inspectPdf(bytes);
    return {
      bytes,
      filename: normalizeFilename(file.name || "contract.pdf", "contract.pdf"),
      pageCount,
      sha256: await sha256Hex(bytes),
    };
  } catch (cause) {
    if (cause instanceof InvalidPdfError) return cause.message;
    throw cause;
  }
}

function storeDocument(
  context: TemplateContext,
  key: string,
  document: DocumentInput,
) {
  return context.env.STORAGE.put(key, document.bytes, {
    customMetadata: { organizationId: context.get("organizationId") },
    httpMetadata: { contentType: "application/pdf" },
  });
}

function positiveInteger(value: string) {
  return (
    /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 1
  );
}

function notFound(context: TemplateContext) {
  return context.json({ error: "Contract template not found." }, 404);
}

export { contractTemplates };
