import { Hono } from "hono";
import PostalMime from "postal-mime";
import type { Bindings } from "./types";

const inbox = new Hono<{ Bindings: Bindings }>();

interface InboundEmailRow {
  attachment_count: number;
  envelope_from: string;
  envelope_to: string;
  id: string;
  raw_object_key: string;
  raw_size: number;
  received_at: string;
  subject: string | null;
}

interface InboundEmailAttachmentRow {
  content_type: string;
  filename: string;
  id: string;
  object_key: string;
  size: number;
}

inbox.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT email.id, email.envelope_from, email.envelope_to, email.subject,
            email.raw_object_key, email.raw_size, email.received_at,
            COUNT(attachment.id) AS attachment_count
     FROM inbound_emails AS email
     LEFT JOIN inbound_email_attachments AS attachment
       ON attachment.email_id = email.id
     GROUP BY email.id
     ORDER BY email.received_at DESC
     LIMIT 100`,
  ).all<InboundEmailRow>();

  return context.json({ emails: result.results.map(toEmailSummary) });
});

inbox.get("/:id", async (context) => {
  const email = await findEmail(context.env.DB, context.req.param("id"));
  if (!email) {
    return context.json({ error: "Email not found." }, 404);
  }

  const raw = await context.env.STORAGE.get(email.raw_object_key);
  if (!raw) {
    return context.json({ error: "Email content not found." }, 404);
  }

  const [rawContents, attachments] = await Promise.all([
    raw.arrayBuffer(),
    findAttachments(context.env.DB, email.id),
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
  const attachment = await context.env.DB.prepare(
    `SELECT id, object_key, filename, content_type, size
     FROM inbound_email_attachments
     WHERE id = ? AND email_id = ?`,
  )
    .bind(context.req.param("attachmentId"), context.req.param("emailId"))
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

async function findEmail(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT email.id, email.envelope_from, email.envelope_to, email.subject,
              email.raw_object_key, email.raw_size, email.received_at,
              COUNT(attachment.id) AS attachment_count
       FROM inbound_emails AS email
       LEFT JOIN inbound_email_attachments AS attachment
         ON attachment.email_id = email.id
       WHERE email.id = ?
       GROUP BY email.id`,
    )
    .bind(id)
    .first<InboundEmailRow>();
}

async function findAttachments(database: D1Database, emailId: string) {
  const result = await database
    .prepare(
      `SELECT id, object_key, filename, content_type, size
       FROM inbound_email_attachments
       WHERE email_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(emailId)
    .all<InboundEmailAttachmentRow>();
  return result.results;
}

function toEmailSummary(row: InboundEmailRow) {
  return {
    attachmentCount: row.attachment_count,
    from: row.envelope_from,
    id: row.id,
    rawSize: row.raw_size,
    receivedAt: row.received_at,
    subject: row.subject,
    to: row.envelope_to,
  };
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
