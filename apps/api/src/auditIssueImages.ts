import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { normalizeFilename } from "./filenames";
import type { Bindings } from "./types";

const auditIssueImages = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

const maxImageBytes = 10 * 1024 * 1024;
const maxImageDimension = 12_000;
const maxImagePixels = 40_000_000;
const maxImagesPerIssue = 10;

export interface AuditIssueImageRow {
  content_type: string;
  created_at: string;
  deletion_pending: number;
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
  const sourceBytes = await file.arrayBuffer();
  const validation = await validateImage(context.env.IMAGES, sourceBytes);
  if ("error" in validation) {
    return context.json({ error: validation.error }, validation.status);
  }
  const { bytes, imageType } = validation;

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
          created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'audit_issue_image')`,
      ).bind(
        objectId,
        organizationId,
        objectKey,
        filename,
        imageType.contentType,
        bytes.byteLength,
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
    true,
  );
  if (!row) return context.json({ error: "Issue image not found." }, 404);
  // Make the image inaccessible before touching R2. If either later operation
  // fails, the same DELETE remains able to find this pending row and retry both
  // idempotent cleanup steps without exposing broken metadata to readers.
  await context.env.DB.prepare(
    `UPDATE objects SET deletion_pending = 1
     WHERE id = ? AND organization_id = ? AND kind = 'audit_issue_image'`,
  )
    .bind(row.object_id, organizationId)
    .run();
  await context.env.STORAGE.delete(row.object_key);
  await context.env.DB.prepare(
    `DELETE FROM objects
     WHERE id = ? AND organization_id = ? AND kind = 'audit_issue_image'`,
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
         AND object.kind = 'audit_issue_image'
         AND object.deletion_pending = 0
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
  includePending = false,
) {
  return database
    .prepare(
      `${imageSelect}
       WHERE issue.organization_id = ? AND issue.id = ? AND image.id = ?
         AND object.kind = 'audit_issue_image'
         ${includePending ? "" : "AND object.deletion_pending = 0"}`,
    )
    .bind(organizationId, issueId, imageId)
    .first<AuditIssueImageRow>();
}

const imageSelect = `
  SELECT image.id, image.issue_id, image.object_id, image.created_at,
         object.deletion_pending,
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

function supportedImageType(format: string) {
  switch (format.toLowerCase()) {
    case "image/png":
    case "png":
      return { contentType: "image/png", extension: "png" } as const;
    case "image/jpeg":
    case "jpeg":
    case "jpg":
      return { contentType: "image/jpeg", extension: "jpg" } as const;
    case "image/gif":
    case "gif":
      return { contentType: "image/gif", extension: "gif" } as const;
    case "image/webp":
    case "webp":
      return { contentType: "image/webp", extension: "webp" } as const;
    default:
      return null;
  }
}

async function validateImage(images: ImagesBinding, bytes: ArrayBuffer) {
  let imageInfo: ImageInfoResponse;
  try {
    imageInfo = await images.info(new Blob([bytes]).stream());
  } catch {
    return {
      error: "The uploaded file is not a valid image.",
      status: 400,
    } as const;
  }
  const imageType = supportedImageType(imageInfo.format);
  if (!imageType || !("width" in imageInfo)) {
    return {
      error: "Images must be JPEG, PNG, GIF, or WebP files.",
      status: 400,
    } as const;
  }
  const { height, width } = imageInfo;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > maxImageDimension ||
    height > maxImageDimension ||
    width * height > maxImagePixels
  ) {
    return {
      error:
        "Images must be no larger than 12,000 pixels per side and 40 megapixels.",
      status: 400,
    } as const;
  }
  try {
    const normalized = await images
      .input(new Blob([bytes]).stream())
      .output({ anim: false, format: imageType.contentType });
    const normalizedImageType = supportedImageType(normalized.contentType());
    if (normalizedImageType?.contentType !== imageType.contentType) {
      return {
        error: "The uploaded image could not be normalized safely.",
        status: 400,
      } as const;
    }
    const normalizedBytes = await new Response(
      normalized.image(),
    ).arrayBuffer();
    if (normalizedBytes.byteLength === 0) {
      return {
        error: "The uploaded image could not be normalized safely.",
        status: 400,
      } as const;
    }
    if (normalizedBytes.byteLength > maxImageBytes) {
      return {
        error: "Normalized images must be 10 MB or smaller.",
        status: 413,
      } as const;
    }
    return {
      bytes: normalizedBytes,
      imageType: normalizedImageType,
    } as const;
  } catch {
    return {
      error: "The uploaded image could not be normalized safely.",
      status: 400,
    } as const;
  }
}

export { auditIssueImages };
