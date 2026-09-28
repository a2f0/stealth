import { and, count, eq, isNull, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { type Db, getDb } from "./db";
import { listLinkedEmails, toLinkedEmail } from "./inboundEmailLinks";
import {
  inboundEmailLinks,
  inboundEmails,
  libraryFolders as libraryFoldersTable,
  objects,
} from "./schema";
import type { Bindings } from "./types";

type LibraryEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type LibraryContext = Context<LibraryEnv>;

interface FolderRow {
  created_at: string;
  email_count: number;
  file_count: number;
  id: string;
  name: string;
}

const maxFolderNameLength = 80;

function selectFolders(db: Db) {
  return db
    .select({
      id: libraryFoldersTable.id,
      name: libraryFoldersTable.name,
      created_at: libraryFoldersTable.createdAt,
      file_count: sql<number>`${db
        .select({ count: count() })
        .from(objects)
        .where(
          and(
            eq(objects.organizationId, libraryFoldersTable.organizationId),
            eq(objects.kind, "library"),
            eq(objects.folderId, libraryFoldersTable.id),
          ),
        )}`,
      email_count: sql<number>`${db
        .select({ count: count() })
        .from(inboundEmailLinks)
        .innerJoin(
          inboundEmails,
          eq(inboundEmails.id, inboundEmailLinks.emailId),
        )
        .where(
          and(
            eq(
              inboundEmailLinks.organizationId,
              libraryFoldersTable.organizationId,
            ),
            eq(inboundEmailLinks.targetType, "library_folder"),
            eq(inboundEmailLinks.targetId, libraryFoldersTable.id),
            isNull(inboundEmails.deletedAt),
          ),
        )}`,
    })
    .from(libraryFoldersTable);
}

const libraryFolders = new Hono<LibraryEnv>();

libraryFolders.get("/", async (context) => {
  const rows: FolderRow[] = await selectFolders(getDb(context.env.DB))
    .where(
      eq(libraryFoldersTable.organizationId, context.get("organizationId")),
    )
    .orderBy(sql`${libraryFoldersTable.name} COLLATE NOCASE ASC`);
  return context.json({ folders: rows.map(toFolder) });
});

libraryFolders.post("/", async (context) => {
  const name = await folderName(context);
  if (!name) return invalidName(context);
  const organizationId = context.get("organizationId");
  if (await nameTaken(context.env.DB, organizationId, name)) {
    return duplicateName(context);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb(context.env.DB)
    .insert(libraryFoldersTable)
    .values({ id, organizationId, name, createdAt: now, updatedAt: now });
  return context.json(
    { folder: { createdAt: now, emailCount: 0, fileCount: 0, id, name } },
    201,
  );
});

libraryFolders.get("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const folder: FolderRow | undefined = await selectFolders(
    getDb(context.env.DB),
  )
    .where(
      and(
        eq(libraryFoldersTable.id, context.req.param("id")),
        eq(libraryFoldersTable.organizationId, organizationId),
      ),
    )
    .get();
  if (!folder) return folderNotFound(context);
  const emails = await listLinkedEmails(
    context.env.DB,
    organizationId,
    "library_folder",
    folder.id,
  );
  return context.json({
    emails: emails.map(toLinkedEmail),
    folder: toFolder(folder),
  });
});

libraryFolders.patch("/:id", async (context) => {
  const id = context.req.param("id");
  const name = await folderName(context);
  if (!name) return invalidName(context);
  const organizationId = context.get("organizationId");
  if (!(await findLibraryFolder(context.env.DB, organizationId, id))) {
    return folderNotFound(context);
  }
  if (await nameTaken(context.env.DB, organizationId, name, id)) {
    return duplicateName(context);
  }
  await getDb(context.env.DB)
    .update(libraryFoldersTable)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(libraryFoldersTable.id, id),
        eq(libraryFoldersTable.organizationId, organizationId),
      ),
    );
  return context.json({ folder: { id, name } });
});

libraryFolders.delete("/:id", async (context) => {
  const id = context.req.param("id");
  const organizationId = context.get("organizationId");
  if (!(await findLibraryFolder(context.env.DB, organizationId, id))) {
    return folderNotFound(context);
  }
  // Return documents to the library root and drop email links explicitly
  // rather than relying on the foreign-key action and trigger alone.
  const db = getDb(context.env.DB);
  await db.batch([
    db
      .update(objects)
      .set({ folderId: null })
      .where(
        and(
          eq(objects.organizationId, organizationId),
          eq(objects.folderId, id),
        ),
      ),
    db
      .delete(inboundEmailLinks)
      .where(
        and(
          eq(inboundEmailLinks.organizationId, organizationId),
          eq(inboundEmailLinks.targetType, "library_folder"),
          eq(inboundEmailLinks.targetId, id),
        ),
      ),
    db
      .delete(libraryFoldersTable)
      .where(
        and(
          eq(libraryFoldersTable.id, id),
          eq(libraryFoldersTable.organizationId, organizationId),
        ),
      ),
  ]);
  return context.body(null, 204);
});

export async function findLibraryFolder(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return getDb(database)
    .select({ id: libraryFoldersTable.id, name: libraryFoldersTable.name })
    .from(libraryFoldersTable)
    .where(
      and(
        eq(libraryFoldersTable.id, id),
        eq(libraryFoldersTable.organizationId, organizationId),
      ),
    )
    .get();
}

async function nameTaken(
  database: D1Database,
  organizationId: string,
  name: string,
  exceptId?: string,
) {
  const existing = await getDb(database)
    .select({ id: libraryFoldersTable.id })
    .from(libraryFoldersTable)
    .where(
      and(
        eq(libraryFoldersTable.organizationId, organizationId),
        sql`${libraryFoldersTable.name} = ${name} COLLATE NOCASE`,
      ),
    )
    .get();
  return Boolean(existing && existing.id !== exceptId);
}

async function folderName(context: LibraryContext) {
  const input: unknown = await context.req.json().catch(() => null);
  if (typeof input !== "object" || input === null) return null;
  const name = Reflect.get(input, "name");
  if (typeof name !== "string") return null;
  const trimmed = name.replaceAll("\0", "").trim().replace(/\s+/g, " ");
  return trimmed && trimmed.length <= maxFolderNameLength ? trimmed : null;
}

function toFolder(row: FolderRow) {
  return {
    createdAt: row.created_at,
    emailCount: row.email_count,
    fileCount: row.file_count,
    id: row.id,
    name: row.name,
  };
}

function invalidName(context: LibraryContext) {
  return context.json(
    { error: `Folder names need 1 to ${maxFolderNameLength} characters.` },
    400,
  );
}

function duplicateName(context: LibraryContext) {
  return context.json({ error: "A folder with that name exists." }, 409);
}

function folderNotFound(context: LibraryContext) {
  return context.json({ error: "Folder not found." }, 404);
}

export { libraryFolders };
