import { type Context, Hono } from "hono";
import PostalMime from "postal-mime";
import type { AuthVariables } from "./authMiddleware";
import { organizationInboxAddress } from "./inboundEmailAddress";
import type { Bindings } from "./types";

type InboxEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};

const inbox = new Hono<InboxEnv>();

interface InboundEmailRow {
  attachment_count: number;
  deleted_at: string | null;
  deleted_by_email: string | null;
  deleted_by_name: string | null;
  deleted_by_user_id: string | null;
  envelope_from: string;
  envelope_to: string;
  id: string;
  raw_object_key: string;
  raw_size: number;
  received_at: string;
  subject: string | null;
}

type InboxFolder = "inbox" | "trash";

interface InboundEmailAttachmentRow {
  content_type: string;
  filename: string;
  id: string;
  object_key: string;
  size: number;
}

inbox.get("/", async (context) => {
  const folder = inboxFolder(context.req.query("folder"));
  if (!folder) return invalidFolder(context);
  const organizationId = context.get("organizationId");
  const deletionFilter = emailDeletionFilter(folder);
  const ordering =
    folder === "trash" ? "email.deleted_at" : "email.received_at";
  const result = await context.env.DB.prepare(
    `SELECT email.id, email.envelope_from, email.envelope_to, email.subject,
            email.raw_object_key, email.raw_size, email.received_at,
            email.deleted_at, email.deleted_by_user_id,
            deleted_by.name AS deleted_by_name,
            deleted_by.email AS deleted_by_email,
            COUNT(attachment.id) AS attachment_count
     FROM inbound_emails AS email
     LEFT JOIN inbound_email_attachments AS attachment
       ON attachment.email_id = email.id
     LEFT JOIN "user" AS deleted_by ON deleted_by.id = email.deleted_by_user_id
     WHERE email.organization_id = ? AND ${deletionFilter}
     GROUP BY email.id
     ORDER BY ${ordering} DESC, email.id DESC
     LIMIT 100`,
  )
    .bind(organizationId)
    .all<InboundEmailRow>();

  return context.json({
    address: organizationInboxAddress(
      organizationId,
      context.env.INBOUND_EMAIL_DOMAIN,
    ),
    emails: result.results.map(toEmailSummary),
  });
});

inbox.get("/:id", async (context) => {
  const folder = inboxFolder(context.req.query("folder"));
  if (!folder) return invalidFolder(context);
  const organizationId = context.get("organizationId");
  const email = await findEmail(
    context.env.DB,
    organizationId,
    context.req.param("id"),
    folder,
  );
  if (!email) {
    return context.json({ error: "Email not found." }, 404);
  }

  const raw = await context.env.STORAGE.get(email.raw_object_key);
  if (!raw) {
    return context.json({ error: "Email content not found." }, 404);
  }

  const [rawContents, attachments] = await Promise.all([
    raw.arrayBuffer(),
    findAttachments(context.env.DB, organizationId, email.id),
  ]);
  const parsed = await PostalMime.parse(rawContents, {
    maxHeadersSize: 128 * 1024,
    maxNestingDepth: 30,
    maxRfc822NestingDepth: 0,
  });

  return context.json({
    email: {
      ...toEmailSummary(email),
      attachments: attachments.map(toAttachment),
      html: parsed.html ?? null,
      text: parsed.text ?? null,
    },
  });
});

inbox.get("/:emailId/attachments/:attachmentId", async (context) => {
  const folder = inboxFolder(context.req.query("folder"));
  if (!folder) return invalidFolder(context);
  const attachment = await context.env.DB.prepare(
    `SELECT attachment.id, attachment.object_key, attachment.filename,
            attachment.content_type, attachment.size
     FROM inbound_email_attachments AS attachment
     JOIN inbound_emails AS email ON email.id = attachment.email_id
     WHERE attachment.id = ? AND attachment.email_id = ?
       AND email.organization_id = ? AND ${emailDeletionFilter(folder)}`,
  )
    .bind(
      context.req.param("attachmentId"),
      context.req.param("emailId"),
      context.get("organizationId"),
    )
    .first<InboundEmailAttachmentRow>();
  if (!attachment) {
    return context.json({ error: "Attachment not found." }, 404);
  }

  const object = await context.env.STORAGE.get(attachment.object_key);
  if (!object) {
    return context.json({ error: "Attachment content not found." }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", attachment.content_type);
  headers.set(
    "content-disposition",
    attachmentDisposition(attachment.filename),
  );
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
});

inbox.delete("/:id", async (context) => {
  const deletedAt = new Date().toISOString();
  const deletedByUserId = context.get("authSession").user.id;
  const result = await context.env.DB.prepare(
    `UPDATE inbound_emails
     SET deleted_at = ?, deleted_by_user_id = ?
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
  )
    .bind(
      deletedAt,
      deletedByUserId,
      context.req.param("id"),
      context.get("organizationId"),
    )
    .run();
  if (result.meta.changes !== 1) {
    return context.json({ error: "Email not found." }, 404);
  }
  return context.json({
    deletedAt,
    deletedByUserId,
    emailId: context.req.param("id"),
  });
});

inbox.post("/:id/restore", async (context) => {
  const result = await context.env.DB.prepare(
    `UPDATE inbound_emails
     SET deleted_at = NULL, deleted_by_user_id = NULL
     WHERE id = ? AND organization_id = ? AND deleted_at IS NOT NULL`,
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .run();
  if (result.meta.changes !== 1) {
    return context.json({ error: "Deleted email not found." }, 404);
  }
  return context.json({ emailId: context.req.param("id") });
});

async function findEmail(
  database: D1Database,
  organizationId: string,
  id: string,
  folder: InboxFolder,
) {
  return database
    .prepare(
      `SELECT email.id, email.envelope_from, email.envelope_to, email.subject,
              email.raw_object_key, email.raw_size, email.received_at,
              email.deleted_at, email.deleted_by_user_id,
              deleted_by.name AS deleted_by_name,
              deleted_by.email AS deleted_by_email,
              COUNT(attachment.id) AS attachment_count
       FROM inbound_emails AS email
       LEFT JOIN inbound_email_attachments AS attachment
         ON attachment.email_id = email.id
       LEFT JOIN "user" AS deleted_by
         ON deleted_by.id = email.deleted_by_user_id
       WHERE email.id = ? AND email.organization_id = ?
         AND ${emailDeletionFilter(folder)}
       GROUP BY email.id`,
    )
    .bind(id, organizationId)
    .first<InboundEmailRow>();
}

async function findAttachments(
  database: D1Database,
  organizationId: string,
  emailId: string,
) {
  const result = await database
    .prepare(
      `SELECT attachment.id, attachment.object_key, attachment.filename,
              attachment.content_type, attachment.size
       FROM inbound_email_attachments AS attachment
       JOIN inbound_emails AS email ON email.id = attachment.email_id
       WHERE attachment.email_id = ? AND email.organization_id = ?
       ORDER BY attachment.created_at ASC`,
    )
    .bind(emailId, organizationId)
    .all<InboundEmailAttachmentRow>();
  return result.results;
}

function toEmailSummary(row: InboundEmailRow) {
  return {
    attachmentCount: row.attachment_count,
    deletedAt: row.deleted_at,
    deletedByEmail: row.deleted_by_email,
    deletedByName: row.deleted_by_name,
    deletedByUserId: row.deleted_by_user_id,
    from: row.envelope_from,
    id: row.id,
    rawSize: row.raw_size,
    receivedAt: row.received_at,
    subject: row.subject,
    to: row.envelope_to,
  };
}

function inboxFolder(value: string | undefined): InboxFolder | null {
  if (!value || value === "inbox") return "inbox";
  return value === "trash" ? "trash" : null;
}

function emailDeletionFilter(folder: InboxFolder) {
  return folder === "trash"
    ? "email.deleted_at IS NOT NULL"
    : "email.deleted_at IS NULL";
}

function invalidFolder(context: Context<InboxEnv>) {
  return context.json({ error: "Folder must be inbox or trash." }, 400);
}

function toAttachment(row: InboundEmailAttachmentRow) {
  return {
    contentType: row.content_type,
    filename: row.filename,
    id: row.id,
    size: row.size,
  };
}

function attachmentDisposition(filename: string) {
  const encodedFilename = encodeURIComponent(filename).replaceAll("'", "%27");
  return `attachment; filename="download"; filename*=UTF-8''${encodedFilename}`;
}

export { inbox };
