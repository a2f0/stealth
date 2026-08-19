import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { normalizeFilename } from "./filenames";
import type { Bindings, StoredObjectRow } from "./types";
import { toStoredObject } from "./types";

const objects = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();
const maxUploadBytes = 25 * 1024 * 1024;

objects.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT id, object_key, filename, content_type, size, created_at
     FROM objects WHERE organization_id = ?
     ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(context.get("organizationId"))
    .all<StoredObjectRow>();

  return context.json({ objects: result.results.map(toStoredObject) });
});

objects.post("/", async (context) => {
  const body = (await context.req.parseBody()) as { file?: File | string };
  const file = body.file;

  if (!(file instanceof File)) {
    return context.json({ error: "A multipart file field is required." }, 400);
  }

  if (file.size > maxUploadBytes) {
    return context.json({ error: "Files must be 25 MB or smaller." }, 413);
  }

  const id = crypto.randomUUID();
  const organizationId = context.get("organizationId");
  const filename = normalizeFilename(file.name);
  const objectKey = `organizations/${organizationId}/uploads/${id}/${filename}`;
  const contentType = file.type || "application/octet-stream";
  const createdAt = new Date().toISOString();

  await context.env.STORAGE.put(objectKey, file, {
    httpMetadata: { contentType },
    customMetadata: { filename, organizationId },
  });

  try {
    await context.env.DB.prepare(
      `INSERT INTO objects
       (id, organization_id, object_key, filename, content_type, size,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        organizationId,
        objectKey,
        filename,
        contentType,
        file.size,
        createdAt,
      )
      .run();
  } catch (error) {
    await context.env.STORAGE.delete(objectKey);
    throw error;
  }

  return context.json(
    {
      object: {
        id,
        objectKey,
        filename,
        contentType,
        size: file.size,
        createdAt,
      },
    },
    201,
  );
});

objects.get("/:id", async (context) => {
  const row = await findObject(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!row) {
    return context.json({ error: "Object not found." }, 404);
  }

  const object = await context.env.STORAGE.get(row.object_key);
  if (!object) {
    return context.json({ error: "Object data not found." }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const encodedFilename = encodeURIComponent(row.filename).replaceAll(
    "'",
    "%27",
  );
  headers.set(
    "content-disposition",
    `attachment; filename="download"; filename*=UTF-8''${encodedFilename}`,
  );
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
});

objects.delete("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const row = await findObject(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!row) {
    return context.json({ error: "Object not found." }, 404);
  }

  await context.env.STORAGE.delete(row.object_key);
  await context.env.DB.prepare(
    "DELETE FROM objects WHERE id = ? AND organization_id = ?",
  )
    .bind(row.id, organizationId)
    .run();

  return context.body(null, 204);
});

async function findObject(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id, object_key, filename, content_type, size, created_at
       FROM objects WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<StoredObjectRow>();
}

export { objects };
