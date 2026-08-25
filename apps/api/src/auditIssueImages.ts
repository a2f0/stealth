import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { normalizeFilename } from "./filenames";
import type { Bindings } from "./types";

const auditIssueImages = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();
type AuditIssueImageContext = Context<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>;

const maxImageBytes = 10 * 1024 * 1024;
const maxImageDimension = 12_000;
const maxImagePixels = 40_000_000;
const maxImagesPerIssue = 10;
// A maximum-size request can briefly retain its 10 MB input buffer, the
// immutable Blob consumed by Images, and a 10 MB normalized R2 body. Keep two
// such pipelines well below Workers' shared 128 MB isolate memory limit.
const maxConcurrentImageUploads = 2;
const maxConcurrentImageUploadsPerOrganization = 1;
const maxImageReadMilliseconds = 60_000;
const pendingUploadGraceMilliseconds = 15 * 60 * 1000;
const pendingCleanupBatchSize = 100;
let activeImageUploads = 0;
const activeOrganizationImageUploads = new Map<string, number>();

function acquireImageUploadCapacity(organizationId: string) {
  const organizationUploads =
    activeOrganizationImageUploads.get(organizationId) ?? 0;
  if (
    activeImageUploads >= maxConcurrentImageUploads ||
    organizationUploads >= maxConcurrentImageUploadsPerOrganization
  ) {
    return null;
  }
  activeImageUploads += 1;
  activeOrganizationImageUploads.set(organizationId, organizationUploads + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeImageUploads -= 1;
    const remaining =
      (activeOrganizationImageUploads.get(organizationId) ?? 1) - 1;
    if (remaining === 0) activeOrganizationImageUploads.delete(organizationId);
    else activeOrganizationImageUploads.set(organizationId, remaining);
  };
}

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

  const releaseCapacity = acquireImageUploadCapacity(organizationId);
  if (releaseCapacity === null) {
    context.header("retry-after", "1");
    return context.json(
      { error: "Image uploads are busy. Please retry in a moment." },
      429,
    );
  }
  try {
    const reservation = await reserveAuditIssueImage(
      context.env.DB,
      organizationId,
      issue.id,
      context.get("authSession").user.id,
      context.req.query("filename"),
    );
    if (reservation === null) {
      return context.json(
        { error: `Issues are limited to ${maxImagesPerIssue} images.` },
        409,
      );
    }
    return await uploadReservedAuditIssueImage(
      context,
      organizationId,
      issue.id,
      reservation,
    );
  } finally {
    releaseCapacity();
  }
});

async function uploadReservedAuditIssueImage(
  context: AuditIssueImageContext,
  organizationId: string,
  issueId: string,
  reservation: AuditIssueImageReservation,
) {
  let upload: Awaited<ReturnType<typeof parseImageUpload>> | undefined;
  let validation: Awaited<ReturnType<typeof validateImage>>;
  let requestedFilename: string;
  try {
    upload = await parseImageUpload(
      context.req.raw,
      context.req.query("filename"),
    );
    if ("error" in upload) {
      await discardAuditIssueImageReservation(
        context.env.DB,
        reservation.objectId,
        reservation.uploadToken,
      );
      return context.json({ error: upload.error }, upload.status);
    }
    requestedFilename = upload.filename;
    validation = await validateImage(context.env.IMAGES, upload.bytes);
    upload = undefined;
    if ("error" in validation) {
      await discardAuditIssueImageReservation(
        context.env.DB,
        reservation.objectId,
        reservation.uploadToken,
      );
      return context.json({ error: validation.error }, validation.status);
    }
  } catch (cause) {
    await discardAuditIssueImageReservation(
      context.env.DB,
      reservation.objectId,
      reservation.uploadToken,
    );
    throw cause;
  }
  const { imageType, stream } = validation;
  const filename = normalizedImageFilename(
    requestedFilename,
    imageType.extension,
  );
  try {
    await persistAuditIssueImage(context.env, stream, {
      contentType: imageType.contentType,
      filename,
      issueId,
      objectId: reservation.objectId,
      objectKey: reservation.objectKey,
      organizationId,
      uploadToken: reservation.uploadToken,
    });
  } catch (cause) {
    if (cause instanceof AuditIssueImageUploadError) {
      return context.json({ error: cause.message }, cause.status);
    }
    throw cause;
  }
  const image = await findAuditIssueImage(
    context.env.DB,
    organizationId,
    issueId,
    reservation.imageId,
  );
  if (!image) throw new Error("Uploaded issue image could not be loaded.");
  return context.json({ image: toAuditIssueImage(image) }, 201);
}

interface AuditIssueImageInsert {
  contentType: string;
  filename: string;
  issueId: string;
  objectId: string;
  objectKey: string;
  organizationId: string;
  uploadToken: string;
}

interface AuditIssueImageReservation {
  imageId: string;
  objectId: string;
  objectKey: string;
  uploadToken: string;
}

async function reserveAuditIssueImage(
  database: D1Database,
  organizationId: string,
  issueId: string,
  userId: string,
  requestedFilename: string | undefined,
): Promise<AuditIssueImageReservation | null> {
  const createdAt = new Date().toISOString();
  const imageId = crypto.randomUUID();
  const objectId = crypto.randomUUID();
  const uploadToken = crypto.randomUUID();
  const uploadLeaseExpiresAt = new Date(
    Date.now() + pendingUploadGraceMilliseconds,
  ).toISOString();
  const objectKey = `organizations/${organizationId}/audit-issues/${issueId}/${objectId}/image`;
  const filename = normalizeFilename(requestedFilename ?? "", "issue-image");
  await database
    .prepare(
      `INSERT INTO objects
       (id, organization_id, object_key, filename, content_type, size,
        created_at, kind, deletion_pending, upload_token,
        upload_lease_expires_at)
       VALUES (?, ?, ?, ?, 'application/octet-stream', 0, ?,
               'audit_issue_image', 1, ?, ?)`,
    )
    .bind(
      objectId,
      organizationId,
      objectKey,
      filename,
      createdAt,
      uploadToken,
      uploadLeaseExpiresAt,
    )
    .run();
  let reserved: { id: string } | null;
  try {
    reserved = await database
      .prepare(
        `WITH RECURSIVE slots(slot) AS (
           VALUES (1)
           UNION ALL
           SELECT slot + 1 FROM slots WHERE slot < ?
         )
         INSERT INTO audit_issue_images
         (id, issue_id, object_id, uploaded_by, created_at, slot)
         SELECT ?, ?, ?, ?, ?, slots.slot
         FROM slots
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_issue_images AS existing
           WHERE existing.issue_id = ? AND existing.slot = slots.slot
         )
         ORDER BY slots.slot ASC
         LIMIT 1
         RETURNING id`,
      )
      .bind(
        maxImagesPerIssue,
        imageId,
        issueId,
        objectId,
        userId,
        createdAt,
        issueId,
      )
      .first<{ id: string }>();
  } catch (cause) {
    await discardAuditIssueImageReservation(database, objectId, uploadToken);
    throw cause;
  }
  if (reserved === null) {
    await discardAuditIssueImageReservation(database, objectId, uploadToken);
    return null;
  }
  return { imageId, objectId, objectKey, uploadToken };
}

async function discardAuditIssueImageReservation(
  database: D1Database,
  objectId: string,
  uploadToken: string,
) {
  await database.batch([
    database
      .prepare(
        `DELETE FROM audit_issue_images
         WHERE object_id = ? AND EXISTS (
           SELECT 1 FROM objects
           WHERE id = ? AND kind = 'audit_issue_image'
             AND deletion_pending = 1 AND cleanup_token IS NULL
             AND upload_token = ?
         )`,
      )
      .bind(objectId, objectId, uploadToken),
    database
      .prepare(
        `DELETE FROM objects
         WHERE id = ? AND kind = 'audit_issue_image'
           AND deletion_pending = 1 AND cleanup_token IS NULL
           AND upload_token = ?`,
      )
      .bind(objectId, uploadToken),
  ]);
}

function normalizedImageFilename(filename: string, extension: string) {
  const normalized = normalizeFilename(filename, "issue-image");
  const dotIndex = normalized.lastIndexOf(".");
  const stem = dotIndex > 0 ? normalized.slice(0, dotIndex) : normalized;
  const suffix = `.${extension}`;
  const trimmedStem = stem.slice(0, 255 - suffix.length) || "issue-image";
  return `${trimmedStem}${suffix}`;
}

class AuditIssueImageUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 408 | 413,
  ) {
    super(message);
  }
}

async function abandonAuditIssueImageUpload(
  database: D1Database,
  objectId: string,
  uploadToken: string,
) {
  await database
    .prepare(
      `UPDATE objects
       SET upload_token = NULL, upload_lease_expires_at = NULL
       WHERE id = ? AND kind = 'audit_issue_image'
         AND deletion_pending = 1 AND upload_token = ?`,
    )
    .bind(objectId, uploadToken)
    .run();
}

async function persistAuditIssueImage(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  stream: ReadableStream<Uint8Array>,
  image: AuditIssueImageInsert,
) {
  await refreshAuditIssueImageUploadLease(environment.DB, image);
  const normalizedSize = await writeNormalizedAuditIssueImage(
    environment,
    stream,
    image,
  );
  try {
    const activated = await environment.DB.prepare(
      `UPDATE objects
       SET size = ?, deletion_pending = 0, upload_token = NULL,
           upload_lease_expires_at = NULL
       WHERE id = ? AND kind = 'audit_issue_image'
         AND deletion_pending = 1 AND cleanup_token IS NULL
         AND upload_token = ?
         AND EXISTS (
           SELECT 1 FROM audit_issue_images AS reservation
           WHERE reservation.object_id = objects.id
             AND reservation.issue_id = ?
         )`,
    )
      .bind(normalizedSize, image.objectId, image.uploadToken, image.issueId)
      .run();
    if (Number(activated.meta.changes) !== 1) {
      throw new Error("Issue image reservation could not be activated.");
    }
  } catch (cause) {
    const activationCommitted = await recoverFailedAuditIssueImageActivation(
      environment,
      image,
      normalizedSize,
    );
    if (activationCommitted) return;
    throw cause;
  }
}

interface AuditIssueImageActivationState {
  deletion_pending: number;
  object_key: string;
  reservation_exists: number;
}

type ActivationStateRead =
  | { known: true; state: AuditIssueImageActivationState | null }
  | { known: false };

async function readAuditIssueImageActivationState(
  database: D1Database,
  image: AuditIssueImageInsert,
): Promise<ActivationStateRead> {
  try {
    const state = await database
      .prepare(
        `SELECT object_key, deletion_pending,
                EXISTS (
                  SELECT 1 FROM audit_issue_images
                  WHERE object_id = objects.id AND issue_id = ?
                ) AS reservation_exists
         FROM objects
         WHERE id = ? AND organization_id = ? AND kind = 'audit_issue_image'`,
      )
      .bind(image.issueId, image.objectId, image.organizationId)
      .first<AuditIssueImageActivationState>();
    return { known: true, state };
  } catch {
    return { known: false };
  }
}

function isCommittedAuditIssueImageActivation(
  read: ActivationStateRead,
  image: AuditIssueImageInsert,
) {
  return (
    read.known &&
    read.state?.deletion_pending === 0 &&
    read.state.object_key === image.objectKey &&
    read.state.reservation_exists === 1
  );
}

async function recoverFailedAuditIssueImageActivation(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  image: AuditIssueImageInsert,
  size: number,
) {
  const initialState = await readAuditIssueImageActivationState(
    environment.DB,
    image,
  );
  if (isCommittedAuditIssueImageActivation(initialState, image)) return true;
  // A failed state read makes the activation result ambiguous. Retain R2 bytes
  // so a committed image can never be turned into an active dangling row.
  if (!initialState.known) return false;

  try {
    await restoreAuditIssueImageCleanupTombstone(environment.DB, image, size);
  } catch (tombstoneCause) {
    const latestState = await readAuditIssueImageActivationState(
      environment.DB,
      image,
    );
    if (isCommittedAuditIssueImageActivation(latestState, image)) return true;
    // Delete only after an authoritative read proves the object is absent or
    // still pending. Unknown or unexpectedly active state retains the bytes.
    if (!latestState.known || latestState.state?.deletion_pending === 0) {
      return false;
    }
    try {
      await environment.STORAGE.delete(image.objectKey);
      return false;
    } catch (deleteCause) {
      throw new AggregateError(
        [tombstoneCause, deleteCause],
        "Issue image activation and cleanup recovery both failed.",
      );
    }
  }
  const restoredState = await readAuditIssueImageActivationState(
    environment.DB,
    image,
  );
  if (isCommittedAuditIssueImageActivation(restoredState, image)) return true;
  await attemptPendingObjectCleanup(environment, image.objectId);
  return false;
}

async function restoreAuditIssueImageCleanupTombstone(
  database: D1Database,
  image: AuditIssueImageInsert,
  size: number,
) {
  await database
    .prepare(
      `INSERT INTO objects
       (id, organization_id, object_key, filename, content_type, size,
        created_at, kind, deletion_pending, cleanup_token,
        cleanup_claimed_at, upload_token, upload_lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'audit_issue_image', 1,
               NULL, NULL, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET
         organization_id = excluded.organization_id,
         object_key = excluded.object_key,
         filename = excluded.filename,
         content_type = excluded.content_type,
         size = excluded.size,
         deletion_pending = 1,
         cleanup_token = NULL,
         cleanup_claimed_at = NULL,
         upload_token = NULL,
         upload_lease_expires_at = NULL
       WHERE objects.kind = 'audit_issue_image'
         AND objects.deletion_pending = 1`,
    )
    .bind(
      image.objectId,
      image.organizationId,
      image.objectKey,
      image.filename,
      image.contentType,
      size,
      new Date().toISOString(),
    )
    .run();
}

async function refreshAuditIssueImageUploadLease(
  database: D1Database,
  image: AuditIssueImageInsert,
) {
  // The pending object and image row already reserve a unique per-issue slot.
  // Fill in the validated metadata before writing bytes so any later failure
  // leaves a complete durable cleanup tombstone.
  try {
    const metadata = await database
      .prepare(
        `UPDATE objects
       SET filename = ?, content_type = ?, upload_lease_expires_at = ?
       WHERE id = ? AND organization_id = ? AND kind = 'audit_issue_image'
         AND deletion_pending = 1 AND cleanup_token IS NULL
         AND upload_token = ?`,
      )
      .bind(
        image.filename,
        image.contentType,
        new Date(Date.now() + pendingUploadGraceMilliseconds).toISOString(),
        image.objectId,
        image.organizationId,
        image.uploadToken,
      )
      .run();
    if (Number(metadata.meta.changes) !== 1) {
      throw new Error("Issue image reservation is no longer available.");
    }
  } catch (cause) {
    await discardAuditIssueImageReservation(
      database,
      image.objectId,
      image.uploadToken,
    );
    throw cause;
  }
}

async function abandonAndCleanupAuditIssueImage(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  image: AuditIssueImageInsert,
) {
  await abandonAuditIssueImageUpload(
    environment.DB,
    image.objectId,
    image.uploadToken,
  );
  await attemptPendingObjectCleanup(environment, image.objectId);
}

async function writeNormalizedAuditIssueImage(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  stream: ReadableStream<Uint8Array>,
  image: AuditIssueImageInsert,
) {
  let normalizedBytes: Uint8Array | null;
  try {
    normalizedBytes = await readBodyWithLimit(
      stream,
      maxImageBytes,
      maxImageReadMilliseconds,
    );
  } catch (cause) {
    await abandonAndCleanupAuditIssueImage(environment, image);
    if (cause instanceof ImageUploadReadTimeoutError) {
      throw new AuditIssueImageUploadError(
        "Image processing must finish within 60 seconds.",
        408,
      );
    }
    throw cause;
  }
  if (normalizedBytes === null) {
    await abandonAndCleanupAuditIssueImage(environment, image);
    throw new AuditIssueImageUploadError(
      "Normalized images must be 10 MB or smaller.",
      413,
    );
  }
  if (normalizedBytes.byteLength === 0) {
    await abandonAndCleanupAuditIssueImage(environment, image);
    throw new AuditIssueImageUploadError(
      "The uploaded image could not be normalized safely.",
      400,
    );
  }
  try {
    // R2 requires a body with a known length. A Uint8Array preserves the
    // bounded byte length; a generic TransformStream is rejected by workerd.
    await environment.STORAGE.put(image.objectKey, normalizedBytes, {
      httpMetadata: { contentType: image.contentType },
      customMetadata: {
        filename: image.filename,
        issueId: image.issueId,
        organizationId: image.organizationId,
      },
    });
  } catch (cause) {
    await abandonAndCleanupAuditIssueImage(environment, image);
    throw cause;
  }
  return normalizedBytes.byteLength;
}

async function parseImageUpload(
  request: Request,
  filename: string | undefined,
): Promise<
  | { bytes: Uint8Array; filename: string }
  | { error: string; status: 400 | 408 | 413 }
> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
    return { error: "Images must be 10 MB or smaller.", status: 413 };
  }
  const contentType = request.headers.get("content-type") ?? "";
  const declaredType = (contentType.split(";", 1)[0] ?? "").toLowerCase();
  if (
    declaredType !== "application/octet-stream" &&
    !supportedImageType(declaredType)
  ) {
    return {
      error: "Images must be JPEG, PNG, GIF, or WebP files.",
      status: 400,
    };
  }
  let requestBytes: Uint8Array | null;
  try {
    requestBytes = await readBodyWithLimit(
      request.body,
      maxImageBytes,
      maxImageReadMilliseconds,
    );
  } catch (cause) {
    if (cause instanceof ImageUploadReadTimeoutError) {
      return {
        error: "Images must finish uploading within 60 seconds.",
        status: 408,
      };
    }
    throw cause;
  }
  if (requestBytes === null) {
    return { error: "Images must be 10 MB or smaller.", status: 413 };
  }
  if (requestBytes.byteLength === 0) {
    return { error: "The uploaded file is not a valid image.", status: 400 };
  }
  return { bytes: requestBytes, filename: filename || "issue-image" };
}

export class ImageUploadReadTimeoutError extends Error {}

function cancelBodyReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
) {
  // Cancellation is cleanup, not part of the upload deadline. A hostile or
  // broken source may never settle its cancel hook, so observe rejection
  // without letting that hook retain the global and organization upload slots.
  void reader.cancel(reason).catch(() => undefined);
}

/** Read a request stream with fixed memory and a cancellation deadline. */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMilliseconds = maxImageReadMilliseconds,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let total = 0;
  const timeoutError = new ImageUploadReadTimeoutError(
    "image upload read deadline exceeded",
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(timeoutError), timeoutMilliseconds);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) return bytes.subarray(0, total);
      if (total + value.byteLength > maxBytes) {
        cancelBodyReader(reader, "request body exceeded image upload limit");
        return null;
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch (cause) {
    if (cause === timeoutError) {
      cancelBodyReader(reader, timeoutError);
    }
    throw cause;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }
}

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
  if (context.req.query("variant") === "thumbnail") {
    try {
      const thumbnail = await context.env.IMAGES.input(object.body)
        .transform({ fit: "scale-down", height: 480, width: 480 })
        .output({ anim: false, format: "image/webp", quality: 80 });
      const response = thumbnail.response();
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("content-disposition", 'inline; filename="thumbnail.webp"');
      headers.set("x-content-type-options", "nosniff");
      return new Response(response.body, { headers, status: response.status });
    } catch (cause) {
      console.error("Audit issue thumbnail generation failed.", cause);
      return context.json(
        { error: "Issue thumbnail could not be generated." },
        502,
      );
    }
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

interface PendingAuditIssueObject {
  id: string;
}

async function deletePendingAuditIssueObject(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  object: PendingAuditIssueObject,
  abandonedClaimCutoff = new Date(
    Date.now() - pendingUploadGraceMilliseconds,
  ).toISOString(),
  uploadLeaseCutoff = new Date().toISOString(),
) {
  const cleanupToken = crypto.randomUUID();
  const claimedAt = new Date().toISOString();
  const claimed = await environment.DB.prepare(
    `UPDATE objects
     SET cleanup_token = ?, cleanup_claimed_at = ?, upload_token = NULL,
         upload_lease_expires_at = NULL
     WHERE id = ? AND kind = 'audit_issue_image' AND deletion_pending = 1
       AND (cleanup_token IS NULL OR datetime(cleanup_claimed_at) <= datetime(?))
       AND (
         upload_token IS NULL OR (
           upload_lease_expires_at IS NOT NULL
           AND datetime(upload_lease_expires_at) <= datetime(?)
         )
       )
     RETURNING object_key`,
  )
    .bind(
      cleanupToken,
      claimedAt,
      object.id,
      abandonedClaimCutoff,
      uploadLeaseCutoff,
    )
    .first<{ object_key: string }>();
  if (!claimed) return false;
  await environment.STORAGE.delete(claimed.object_key);
  await environment.DB.batch([
    environment.DB.prepare(
      `DELETE FROM audit_issue_images
       WHERE object_id = ? AND EXISTS (
         SELECT 1 FROM objects
         WHERE id = ? AND kind = 'audit_issue_image'
           AND deletion_pending = 1 AND cleanup_token = ?
       )`,
    ).bind(object.id, object.id, cleanupToken),
    environment.DB.prepare(
      `DELETE FROM objects
       WHERE id = ? AND kind = 'audit_issue_image' AND deletion_pending = 1
         AND cleanup_token = ?`,
    ).bind(object.id, cleanupToken),
  ]);
  return true;
}

async function attemptPendingObjectCleanup(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  id: string,
) {
  try {
    await deletePendingAuditIssueObject(environment, { id });
  } catch (cause) {
    // The D1 tombstone intentionally remains for the scheduled retry.
    console.error("Audit issue image cleanup deferred.", cause);
  }
}

/** Retry durable R2 cleanup tombstones without racing an in-flight upload. */
export async function purgePendingAuditIssueImages(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  cutoff = new Date(Date.now() - pendingUploadGraceMilliseconds).toISOString(),
  uploadLeaseCutoff = new Date().toISOString(),
) {
  const result = await environment.DB.prepare(
    `SELECT id FROM objects
     WHERE kind = 'audit_issue_image' AND deletion_pending = 1
       AND datetime(created_at) <= datetime(?)
       AND (cleanup_token IS NULL OR datetime(cleanup_claimed_at) <= datetime(?))
       AND (
         upload_token IS NULL OR (
           upload_lease_expires_at IS NOT NULL
           AND datetime(upload_lease_expires_at) <= datetime(?)
         )
       )
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(cutoff, cutoff, uploadLeaseCutoff, pendingCleanupBatchSize)
    .all<PendingAuditIssueObject>();
  let firstFailure: unknown;
  let purged = 0;
  for (const object of result.results) {
    try {
      const deleted = await deletePendingAuditIssueObject(
        environment,
        object,
        cutoff,
        uploadLeaseCutoff,
      );
      if (deleted) purged += 1;
    } catch (cause) {
      firstFailure ??= cause;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
  return purged;
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
  // Atomically hide the image and release its unique issue slot before R2
  // cleanup. A failed R2 delete leaves a durable object tombstone for cron.
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE objects
       SET deletion_pending = 1, cleanup_token = NULL,
           cleanup_claimed_at = NULL, upload_token = NULL,
           upload_lease_expires_at = NULL
       WHERE id = ? AND organization_id = ? AND kind = 'audit_issue_image'`,
    ).bind(row.object_id, organizationId),
    context.env.DB.prepare(
      `DELETE FROM audit_issue_images WHERE id = ? AND object_id = ?`,
    ).bind(row.id, row.object_id),
  ]);
  try {
    await deletePendingAuditIssueObject(context.env, {
      id: row.object_id,
    });
  } catch {
    return context.json({ cleanupPending: true }, 202);
  }
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

async function validateImage(images: ImagesBinding, bytes: Uint8Array) {
  let imageInfo: ImageInfoResponse;
  const input = new Blob([bytes]);
  try {
    imageInfo = await images.info(input.stream());
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
      .input(input.stream())
      .output({ anim: false, format: imageType.contentType });
    const normalizedImageType = supportedImageType(normalized.contentType());
    if (normalizedImageType?.contentType !== imageType.contentType) {
      return {
        error: "The uploaded image could not be normalized safely.",
        status: 400,
      } as const;
    }
    return {
      imageType: normalizedImageType,
      stream: normalized.image(),
    } as const;
  } catch {
    return {
      error: "The uploaded image could not be normalized safely.",
      status: 400,
    } as const;
  }
}

export { auditIssueImages };
