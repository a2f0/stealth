import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { listLinkedEmails, toLinkedEmail } from "./inboundEmailLinks";
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

const folderSelect = `
  SELECT folder.id, folder.name, folder.created_at,
         (SELECT COUNT(*) FROM objects AS object
          WHERE object.organization_id = folder.organization_id
            AND object.kind = 'library' AND object.folder_id = folder.id)
           AS file_count,
         (SELECT COUNT(*) FROM inbound_email_links AS link
          JOIN inbound_emails AS email ON email.id = link.email_id
          WHERE link.organization_id = folder.organization_id
            AND link.target_type = 'library_folder'
            AND link.target_id = folder.id
            AND email.deleted_at IS NULL)
           AS email_count
  FROM library_folders AS folder`;

const libraryFolders = new Hono<LibraryEnv>();

libraryFolders.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `${folderSelect} WHERE folder.organization_id = ?
     ORDER BY folder.name COLLATE NOCASE ASC`,
  )
    .bind(context.get("organizationId"))
    .all<FolderRow>();
  return context.json({ folders: result.results.map(toFolder) });
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
  await context.env.DB.prepare(
    `INSERT INTO library_folders
       (id, organization_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, organizationId, name, now, now)
    .run();
  return context.json(
    { folder: { createdAt: now, emailCount: 0, fileCount: 0, id, name } },
    201,
  );
});

libraryFolders.get("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const folder = await context.env.DB.prepare(
    `${folderSelect} WHERE folder.id = ? AND folder.organization_id = ?`,
  )
    .bind(context.req.param("id"), organizationId)
    .first<FolderRow>();
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
  await context.env.DB.prepare(
    `UPDATE library_folders SET name = ?, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(name, new Date().toISOString(), id, organizationId)
    .run();
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
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE objects SET folder_id = NULL
       WHERE organization_id = ? AND folder_id = ?`,
    ).bind(organizationId, id),
    context.env.DB.prepare(
      `DELETE FROM inbound_email_links
       WHERE organization_id = ? AND target_type = 'library_folder'
         AND target_id = ?`,
    ).bind(organizationId, id),
    context.env.DB.prepare(
      `DELETE FROM library_folders WHERE id = ? AND organization_id = ?`,
    ).bind(id, organizationId),
  ]);
  return context.body(null, 204);
});

export async function findLibraryFolder(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id, name FROM library_folders
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<{ id: string; name: string }>();
}

async function nameTaken(
  database: D1Database,
  organizationId: string,
  name: string,
  exceptId?: string,
) {
  const existing = await database
    .prepare(
      `SELECT id FROM library_folders
       WHERE organization_id = ? AND name = ? COLLATE NOCASE`,
    )
    .bind(organizationId, name)
    .first<{ id: string }>();
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
