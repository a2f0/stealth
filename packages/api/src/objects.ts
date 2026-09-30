import { and, desc, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { getDb } from "./db";
import { maxFilenameBytes, normalizeFilename } from "./filenames";
import { findLibraryFolder } from "./libraryFolders";
import { objects as objectsTable } from "./schema";
import type { Bindings, StoredObjectRow } from "./types";
import { toStoredObject } from "./types";

const objects = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();
const maxUploadBytes = 25 * 1024 * 1024;
const maxR2ObjectKeyBytes = 1_024;
const storedObjectColumns = {
  id: objectsTable.id,
  object_key: objectsTable.objectKey,
  filename: objectsTable.filename,
  content_type: objectsTable.contentType,
  size: objectsTable.size,
  created_at: objectsTable.createdAt,
  folder_id: objectsTable.folderId,
};

// Lists one folder's documents, or the documents at the library root.
objects.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const folderId = context.req.query("folder") || null;
  if (
    folderId &&
    !(await findLibraryFolder(context.env.DB, organizationId, folderId))
  ) {
    return folderNotFound(context);
  }
  const rows: StoredObjectRow[] = await getDb(context.env.DB)
    .select(storedObjectColumns)
    .from(objectsTable)
    .where(
      and(
        eq(objectsTable.organizationId, organizationId),
        eq(objectsTable.kind, "library"),
        sql`${objectsTable.folderId} IS ${folderId}`,
      ),
    )
    .orderBy(desc(objectsTable.createdAt))
    .limit(100);

  return context.json({ objects: rows.map(toStoredObject) });
});

objects.post("/", async (context) => {
  const body = (await context.req.parseBody()) as {
    file?: File | string;
    folderId?: File | string;
  };
  const file = body.file;
  const folderId =
    typeof body.folderId === "string" && body.folderId ? body.folderId : null;

  if (!(file instanceof File)) {
    return context.json({ error: "A multipart file field is required." }, 400);
  }

  if (file.size > maxUploadBytes) {
    return context.json({ error: "Files must be 25 MB or smaller." }, 413);
  }

  const id = crypto.randomUUID();
  const organizationId = context.get("organizationId");
  if (
    folderId &&
    !(await findLibraryFolder(context.env.DB, organizationId, folderId))
  ) {
    return folderNotFound(context);
  }
  const objectKeyPrefix = `organizations/${organizationId}/uploads/${id}/`;
  const filenameByteBudget =
    maxR2ObjectKeyBytes - new TextEncoder().encode(objectKeyPrefix).byteLength;
  if (filenameByteBudget < 1) {
    return context.json(
      { error: "Organization storage path is too long." },
      500,
    );
  }
  const filename = normalizeFilename(
    file.name,
    "upload",
    Math.min(maxFilenameBytes, filenameByteBudget),
  );
  const objectKey = `${objectKeyPrefix}${filename}`;
  const contentType = file.type || "application/octet-stream";
  const createdAt = new Date().toISOString();

  await context.env.STORAGE.put(objectKey, file, {
    httpMetadata: { contentType },
    customMetadata: { filename, organizationId },
  });

  try {
    await getDb(context.env.DB).insert(objectsTable).values({
      id,
      organizationId,
      objectKey,
      filename,
      contentType,
      size: file.size,
      createdAt,
      kind: "library",
      folderId,
    });
  } catch (error) {
    await context.env.STORAGE.delete(objectKey);
    throw error;
  }

  return context.json(
    {
      object: {
        folderId,
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

// Moves a document into a folder, or back to the library root with null.
objects.patch("/:id", async (context) => {
  const input: unknown = await context.req.json().catch(() => null);
  const folderId = folderIdFrom(input);
  if (folderId === undefined) {
    return context.json({ error: "A folder or null is required." }, 400);
  }
  const organizationId = context.get("organizationId");
  const row = await findObject(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!row) {
    return context.json({ error: "Object not found." }, 404);
  }
  if (
    folderId &&
    !(await findLibraryFolder(context.env.DB, organizationId, folderId))
  ) {
    return folderNotFound(context);
  }
  await getDb(context.env.DB)
    .update(objectsTable)
    .set({ folderId })
    .where(libraryObject(organizationId, row.id));
  return context.json({
    object: toStoredObject({ ...row, folder_id: folderId }),
  });
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
  await getDb(context.env.DB)
    .delete(objectsTable)
    .where(libraryObject(organizationId, row.id));

  return context.body(null, 204);
});

async function findObject(
  database: D1Database,
  organizationId: string,
  id: string,
): Promise<StoredObjectRow | undefined> {
  return getDb(database)
    .select(storedObjectColumns)
    .from(objectsTable)
    .where(libraryObject(organizationId, id))
    .get();
}

function libraryObject(organizationId: string, id: string) {
  return and(
    eq(objectsTable.id, id),
    eq(objectsTable.organizationId, organizationId),
    eq(objectsTable.kind, "library"),
  );
}

/** A folder id, null for the library root, or undefined when invalid. */
function folderIdFrom(input: unknown) {
  if (typeof input !== "object" || input === null) return undefined;
  const folderId = Reflect.get(input, "folderId");
  if (folderId === null) return null;
  return typeof folderId === "string" &&
    folderId.length > 0 &&
    folderId.length <= 100
    ? folderId
    : undefined;
}

function folderNotFound(context: Context) {
  return context.json({ error: "Folder not found." }, 404);
}

export { objects };
