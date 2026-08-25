import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { normalizeFilename } from "./filenames";
import type { Bindings } from "./types";

const auditIssueImages = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

const maxImageBytes = 10 * 1024 * 1024;
const maxImagesPerIssue = 10;

export interface AuditIssueImageRow {
  content_type: string;
  created_at: string;
  filename: string;
  id: string;
  issue_id: string;
  object_id: string;
  object_key: string;
  size: number;
  uploaded_by_email: string;
  uploaded_by_id: string;
  uploaded_by_name: string;
}

auditIssueImages.post("/:issueId/images", async (context) => {
  const organizationId = context.get("organizationId");
  const issueId = context.req.param("issueId");
  const issue = await context.env.DB.prepare(
    `SELECT id FROM audit_issues WHERE id = ? AND organization_id = ?`,
  )
    .bind(issueId, organizationId)
    .first<{ id: string }>();
  if (!issue) return context.json({ error: "Issue not found." }, 404);

  const body = (await context.req.parseBody()) as { file?: File | string };
  const file = body.file;
  if (!(file instanceof File)) {
    return context.json({ error: "A multipart image field is required." }, 400);
  }
  if (file.size > maxImageBytes) {
    return context.json({ error: "Images must be 10 MB or smaller." }, 413);
  }
  const bytes = await file.arrayBuffer();
  const imageType = detectImageType(new Uint8Array(bytes));
  if (!imageType) {
    return context.json(
      { error: "Images must be JPEG, PNG, GIF, or WebP files." },
      400,
    );
  }

  const id = crypto.randomUUID();
  const objectId = crypto.randomUUID();
  const filename = normalizeFilename(
    file.name,
    `issue-image.${imageType.extension}`,
  );
  const objectKey =
    `organizations/${organizationId}/audit-issues/${issue.id}/` +
    `${objectId}/${filename}`;
  const userId = context.get("authSession").user.id;
  const createdAt = new Date().toISOString();
  await context.env.STORAGE.put(objectKey, bytes, {
    httpMetadata: { contentType: imageType.contentType },
    customMetadata: { filename, issueId: issue.id, organizationId },
  });
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO objects
         (id, organization_id, object_key, filename, content_type, size,
          created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        objectId,
        organizationId,
        objectKey,
        filename,
        imageType.contentType,
        file.size,
        createdAt,
      ),
      context.env.DB.prepare(
        `INSERT INTO audit_issue_images
         (id, issue_id, object_id, uploaded_by, created_at, slot)
         VALUES (
           ?, ?, ?, ?, ?,
           (WITH RECURSIVE slots(slot) AS (
              VALUES (1)
              UNION ALL
              SELECT slot + 1 FROM slots WHERE slot < ?
            )
            SELECT slot FROM slots
            WHERE NOT EXISTS (
              SELECT 1 FROM audit_issue_images AS existing
              WHERE existing.issue_id = ? AND existing.slot = slots.slot
            )
            ORDER BY slot ASC
            LIMIT 1)
         )`,
      ).bind(
        id,
        issue.id,
        objectId,
        userId,
        createdAt,
        maxImagesPerIssue,
        issue.id,
      ),
    ]);
  } catch (cause) {
    await context.env.STORAGE.delete(objectKey);
    if (await issueHasMaximumImages(context.env.DB, issue.id)) {
      return context.json(
        { error: `Issues are limited to ${maxImagesPerIssue} images.` },
        409,
      );
    }
    throw cause;
  }
  const image = await findAuditIssueImage(
    context.env.DB,
    organizationId,
    issue.id,
    id,
  );
  if (!image) throw new Error("Uploaded issue image could not be loaded.");
  return context.json({ image: toAuditIssueImage(image) }, 201);
});

auditIssueImages.get("/:issueId/images/:imageId", async (context) => {
  const row = await findAuditIssueImage(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("issueId"),
    context.req.param("imageId"),
  );
  if (!row) return context.json({ error: "Issue image not found." }, 404);
  const object = await context.env.STORAGE.get(row.object_key);
  if (!object) {
    return context.json({ error: "Issue image data not found." }, 404);
  }
  const encodedFilename = encodeURIComponent(row.filename).replaceAll(
    "'",
    "%27",
  );
  const headers = new Headers({
    "cache-control": "no-store",
    "content-disposition": `inline; filename="image"; filename*=UTF-8''${encodedFilename}`,
    "content-length": String(row.size),
    "content-type": row.content_type,
    etag: object.httpEtag,
    "x-content-type-options": "nosniff",
  });
  return new Response(object.body, { headers });
});

async function issueHasMaximumImages(database: D1Database, issueId: string) {
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS image_count
       FROM audit_issue_images WHERE issue_id = ?`,
    )
    .bind(issueId)
    .first<{ image_count: number }>();
  return Number(count?.image_count ?? 0) >= maxImagesPerIssue;
}

auditIssueImages.delete("/:issueId/images/:imageId", async (context) => {
  const organizationId = context.get("organizationId");
  const row = await findAuditIssueImage(
    context.env.DB,
    organizationId,
    context.req.param("issueId"),
    context.req.param("imageId"),
  );
  if (!row) return context.json({ error: "Issue image not found." }, 404);
  await context.env.STORAGE.delete(row.object_key);
  await context.env.DB.prepare(
    `DELETE FROM objects WHERE id = ? AND organization_id = ?`,
  )
    .bind(row.object_id, organizationId)
    .run();
  return context.body(null, 204);
});

export async function findAuditIssueImages(
  database: D1Database,
  organizationId: string,
  auditId: string,
) {
  const result = await database
    .prepare(
      `${imageSelect}
       WHERE issue.organization_id = ? AND issue.audit_id = ?
       ORDER BY image.created_at ASC`,
    )
    .bind(organizationId, auditId)
    .all<AuditIssueImageRow>();
  return result.results;
}

async function findAuditIssueImage(
  database: D1Database,
  organizationId: string,
  issueId: string,
  imageId: string,
) {
  return database
    .prepare(
      `${imageSelect}
       WHERE issue.organization_id = ? AND issue.id = ? AND image.id = ?`,
    )
    .bind(organizationId, issueId, imageId)
    .first<AuditIssueImageRow>();
}

const imageSelect = `
  SELECT image.id, image.issue_id, image.object_id, image.created_at,
         object.object_key, object.filename, object.content_type, object.size,
         uploader.id AS uploaded_by_id, uploader.name AS uploaded_by_name,
         uploader.email AS uploaded_by_email
  FROM audit_issue_images AS image
  JOIN audit_issues AS issue ON issue.id = image.issue_id
  JOIN objects AS object ON object.id = image.object_id
  JOIN user AS uploader ON uploader.id = image.uploaded_by`;

export function toAuditIssueImage(row: AuditIssueImageRow) {
  return {
    contentType: row.content_type,
    createdAt: row.created_at,
    filename: row.filename,
    id: row.id,
    size: row.size,
    uploadedBy: {
      email: row.uploaded_by_email,
      id: row.uploaded_by_id,
      name: row.uploaded_by_name,
    },
  };
}

function detectImageType(bytes: Uint8Array) {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: "image/png", extension: "png" };
  }
  if (matches(bytes, [0xff, 0xd8, 0xff])) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    matches(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    matches(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return { contentType: "image/gif", extension: "gif" };
  }
  if (
    matches(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

function matches(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

export { auditIssueImages };
