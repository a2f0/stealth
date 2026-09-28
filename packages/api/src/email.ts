import { and, eq, isNull } from "drizzle-orm";
import type { Attachment } from "postal-mime";
import PostalMime from "postal-mime";
import { getDb } from "./db";
import { normalizeFilename } from "./filenames";
import { organizationIdForInboundAddress } from "./inboundEmailAddress";
import { inboundEmailAttachments, inboundEmails, organization } from "./schema";
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
  const organizationId = organizationIdForInboundAddress(
    message.to,
    env.INBOUND_EMAIL_DOMAIN,
  );
  if (!organizationId) {
    message.setReject("Unknown recipient");
    return;
  }

  if (message.rawSize > maxEmailBytes) {
    message.setReject("Messages must be 25 MB or smaller");
    return;
  }

  const recipientOrganization = await getDb(env.DB)
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(eq(organization.id, organizationId), isNull(organization.deletedAt)),
    )
    .get();
  if (!recipientOrganization) {
    message.setReject("Unknown recipient");
    return;
  }

  await ingestInboundEmail(message, recipientOrganization.id, env);
}

async function ingestInboundEmail(
  message: ForwardableEmailMessage,
  organizationId: string,
  env: Pick<Bindings, "DB" | "STORAGE">,
) {
  const emailId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const objectPrefix = `organizations/${organizationId}/inbound-emails/${emailId}`;
  const rawObjectKey = `${objectPrefix}/message.eml`;
  const storedObjectKeys = [rawObjectKey];

  try {
    const raw = await new Response(message.raw).arrayBuffer();
    const [, parsed] = await Promise.all([
      env.STORAGE.put(rawObjectKey, raw, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: { emailId, organizationId },
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
          customMetadata: { emailId, organizationId },
        }),
      ),
    );

    const db = getDb(env.DB);
    await db.batch([
      db.insert(inboundEmails).values({
        id: emailId,
        organizationId,
        messageId: normalizeHeaderText(parsed.messageId),
        envelopeFrom: normalizeHeaderText(message.from) ?? "",
        envelopeTo: normalizeHeaderText(message.to) ?? "",
        subject: normalizeHeaderText(parsed.subject),
        rawObjectKey,
        rawSize: message.rawSize,
        receivedAt: createdAt,
      }),
      ...attachments.map((attachment) =>
        db.insert(inboundEmailAttachments).values({
          id: attachment.id,
          emailId,
          objectKey: attachment.objectKey,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          disposition: attachment.disposition,
          contentId: attachment.contentId,
          createdAt,
        }),
      ),
    ]);
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
