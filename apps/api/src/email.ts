import type { Attachment } from "postal-mime";
import PostalMime from "postal-mime";
import { normalizeFilename } from "./filenames";
import type { Bindings } from "./types";

const maxEmailBytes = 25 * 1024 * 1024;
const maxHeaderTextLength = 1_000;

interface StoredAttachment {
  content: Attachment["content"];
  contentId: string | null;
  contentType: string;
  disposition: string | null;
  filename: string;
  id: string;
  objectKey: string;
  size: number;
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Bindings,
) {
  if (message.to.toLowerCase() !== env.INBOUND_EMAIL_ADDRESS.toLowerCase()) {
    message.setReject("Unknown recipient");
    return;
  }

  if (message.rawSize > maxEmailBytes) {
    message.setReject("Messages must be 25 MB or smaller");
    return;
  }

  await ingestInboundEmail(message, env);
}

async function ingestInboundEmail(
  message: ForwardableEmailMessage,
  env: Pick<Bindings, "DB" | "STORAGE">,
) {
  const emailId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const objectPrefix = `inbound-emails/${emailId}`;
  const rawObjectKey = `${objectPrefix}/message.eml`;
  const storedObjectKeys = [rawObjectKey];

  try {
    const raw = await new Response(message.raw).arrayBuffer();
    const [, parsed] = await Promise.all([
      env.STORAGE.put(rawObjectKey, raw, {
        httpMetadata: { contentType: "message/rfc822" },
      }),
      PostalMime.parse(raw, {
        maxHeadersSize: 128 * 1024,
        maxNestingDepth: 30,
        maxRfc822NestingDepth: 0,
      }),
    ]);
    const attachments = parsed.attachments.map((attachment, index) =>
      toStoredAttachment(attachment, index, objectPrefix),
    );
    storedObjectKeys.push(...attachments.map(({ objectKey }) => objectKey));

    await Promise.all(
      attachments.map((attachment) =>
        env.STORAGE.put(attachment.objectKey, attachment.content, {
          httpMetadata: { contentType: attachment.contentType },
        }),
      ),
    );

    const statements = [
      env.DB.prepare(
        `INSERT INTO inbound_emails
         (id, message_id, envelope_from, envelope_to, subject, raw_object_key,
          raw_size, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        emailId,
        normalizeHeaderText(parsed.messageId),
        normalizeHeaderText(message.from) ?? "",
        normalizeHeaderText(message.to) ?? "",
        normalizeHeaderText(parsed.subject),
        rawObjectKey,
        message.rawSize,
        createdAt,
      ),
      ...attachments.map((attachment) =>
        env.DB.prepare(
          `INSERT INTO inbound_email_attachments
           (id, email_id, object_key, filename, content_type, size,
            disposition, content_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          attachment.id,
          emailId,
          attachment.objectKey,
          attachment.filename,
          attachment.contentType,
          attachment.size,
          attachment.disposition,
          attachment.contentId,
          createdAt,
        ),
      ),
    ];

    await env.DB.batch(statements);
  } catch (error) {
    await Promise.allSettled(
      storedObjectKeys.map((objectKey) => env.STORAGE.delete(objectKey)),
    );
    throw error;
  }
}

function toStoredAttachment(
  attachment: Attachment,
  index: number,
  objectPrefix: string,
): StoredAttachment {
  const id = crypto.randomUUID();
  return {
    content: attachment.content,
    contentId: normalizeHeaderText(attachment.contentId),
    contentType: attachment.mimeType || "application/octet-stream",
    disposition: attachment.disposition,
    filename: normalizeFilename(
      attachment.filename ?? "",
      `attachment-${index + 1}`,
    ),
    id,
    objectKey: `${objectPrefix}/attachments/${id}`,
    size: contentByteLength(attachment.content),
  };
}

function contentByteLength(content: Attachment["content"]) {
  return typeof content === "string"
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;
}

function normalizeHeaderText(value: string | undefined) {
  const normalized = value?.replaceAll("\0", "").trim();
  return normalized ? normalized.slice(0, maxHeaderTextLength) : null;
}
