import { and, asc, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import PostalMime from "postal-mime";
import type { AuthVariables } from "./authMiddleware";
import { getDb } from "./db";
import { organizationInboxAddress } from "./inboundEmailAddress";
import {
  createEmailLink,
  deleteEmailLink,
  listEmailLinks,
} from "./inboundEmailLinks";
import { inboundEmailAttachments, inboundEmails, user } from "./schema";
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

const inboundEmailRowColumns = {
  id: inboundEmails.id,
  envelope_from: inboundEmails.envelopeFrom,
  envelope_to: inboundEmails.envelopeTo,
  subject: inboundEmails.subject,
  raw_object_key: inboundEmails.rawObjectKey,
  raw_size: inboundEmails.rawSize,
  received_at: inboundEmails.receivedAt,
  deleted_at: inboundEmails.deletedAt,
  deleted_by_user_id: inboundEmails.deletedByUserId,
  deleted_by_name: user.name,
  deleted_by_email: user.email,
  attachment_count: count(inboundEmailAttachments.id),
};

const inboundEmailAttachmentRowColumns = {
  id: inboundEmailAttachments.id,
  object_key: inboundEmailAttachments.objectKey,
  filename: inboundEmailAttachments.filename,
  content_type: inboundEmailAttachments.contentType,
  size: inboundEmailAttachments.size,
};

inbox.get("/", async (context) => {
  const folder = inboxFolder(context.req.query("folder"));
  if (!folder) return invalidFolder(context);
  const organizationId = context.get("organizationId");
  const deletionFilter = emailDeletionFilter(folder);
  const ordering =
    folder === "trash" ? inboundEmails.deletedAt : inboundEmails.receivedAt;
  const emails = await getDb(context.env.DB)
    .select(inboundEmailRowColumns)
    .from(inboundEmails)
    .leftJoin(
      inboundEmailAttachments,
      eq(inboundEmailAttachments.emailId, inboundEmails.id),
    )
    .leftJoin(user, eq(user.id, inboundEmails.deletedByUserId))
    .where(
      and(eq(inboundEmails.organizationId, organizationId), deletionFilter),
    )
    .groupBy(inboundEmails.id)
    .orderBy(desc(ordering), desc(inboundEmails.id))
    .limit(100);

  return context.json({
    address: organizationInboxAddress(
      organizationId,
      context.env.INBOUND_EMAIL_DOMAIN,
    ),
    emails: emails.map(toEmailSummary),
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

  const [rawContents, attachments, links] = await Promise.all([
    raw.arrayBuffer(),
    findAttachments(context.env.DB, organizationId, email.id),
    listEmailLinks(context, organizationId, email.id),
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
      links,
      text: parsed.text ?? null,
    },
  });
});

inbox.post("/:id/links", createEmailLink);
inbox.delete("/:id/links/:linkId", deleteEmailLink);

inbox.get("/:emailId/attachments/:attachmentId", async (context) => {
  const folder = inboxFolder(context.req.query("folder"));
  if (!folder) return invalidFolder(context);
  const attachment = await getDb(context.env.DB)
    .select(inboundEmailAttachmentRowColumns)
    .from(inboundEmailAttachments)
    .innerJoin(
      inboundEmails,
      eq(inboundEmails.id, inboundEmailAttachments.emailId),
    )
    .where(
      and(
        eq(inboundEmailAttachments.id, context.req.param("attachmentId")),
        eq(inboundEmailAttachments.emailId, context.req.param("emailId")),
        eq(inboundEmails.organizationId, context.get("organizationId")),
        emailDeletionFilter(folder),
      ),
    )
    .get();
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
  const result = await getDb(context.env.DB)
    .update(inboundEmails)
    .set({ deletedAt, deletedByUserId })
    .where(
      and(
        eq(inboundEmails.id, context.req.param("id")),
        eq(inboundEmails.organizationId, context.get("organizationId")),
        isNull(inboundEmails.deletedAt),
      ),
    );
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
  const result = await getDb(context.env.DB)
    .update(inboundEmails)
    .set({ deletedAt: null, deletedByUserId: null })
    .where(
      and(
        eq(inboundEmails.id, context.req.param("id")),
        eq(inboundEmails.organizationId, context.get("organizationId")),
        isNotNull(inboundEmails.deletedAt),
      ),
    );
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
  return getDb(database)
    .select(inboundEmailRowColumns)
    .from(inboundEmails)
    .leftJoin(
      inboundEmailAttachments,
      eq(inboundEmailAttachments.emailId, inboundEmails.id),
    )
    .leftJoin(user, eq(user.id, inboundEmails.deletedByUserId))
    .where(
      and(
        eq(inboundEmails.id, id),
        eq(inboundEmails.organizationId, organizationId),
        emailDeletionFilter(folder),
      ),
    )
    .groupBy(inboundEmails.id)
    .get();
}

async function findAttachments(
  database: D1Database,
  organizationId: string,
  emailId: string,
) {
  return getDb(database)
    .select(inboundEmailAttachmentRowColumns)
    .from(inboundEmailAttachments)
    .innerJoin(
      inboundEmails,
      eq(inboundEmails.id, inboundEmailAttachments.emailId),
    )
    .where(
      and(
        eq(inboundEmailAttachments.emailId, emailId),
        eq(inboundEmails.organizationId, organizationId),
      ),
    )
    .orderBy(asc(inboundEmailAttachments.createdAt));
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
    ? isNotNull(inboundEmails.deletedAt)
    : isNull(inboundEmails.deletedAt);
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
