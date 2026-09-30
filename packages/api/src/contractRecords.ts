import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  type ContractMail,
  contractUrl,
  sendCompletion,
  sendSigningRequest,
  signingUrl,
} from "./contractMail";
import {
  type Certificate,
  type StampedField,
  sha256Hex,
  stampContract,
} from "./contractPdf";
import {
  newTokenNonce,
  signingToken,
  signingTokenHash,
} from "./contractTokens";
import { getDb } from "./db";
import {
  contractEvents,
  contractFields,
  contractRecipients,
  contracts,
  organization,
  user,
} from "./schema";
import type { Bindings } from "./types";

export type ContractEnvironment = Pick<
  Bindings,
  | "AUTH_EMAIL_FROM"
  | "BETTER_AUTH_SECRET"
  | "CORS_ORIGIN"
  | "DB"
  | "EMAIL"
  | "STORAGE"
>;

export interface ContractRow {
  completed_at: string | null;
  created_at: string;
  created_by: string | null;
  document_filename: string;
  document_object_key: string;
  document_page_count: number;
  document_sha256: string;
  document_size: number;
  due_date: string | null;
  final_object_key: string | null;
  final_sha256: string | null;
  id: string;
  message: string;
  organization_id: string;
  reminder_interval_days: number | null;
  revision: number;
  sent_at: string | null;
  sent_by: string | null;
  signing_order: "parallel" | "sequential";
  status: "completed" | "declined" | "draft" | "sent" | "voided";
  title: string;
  updated_at: string;
  void_reason: string | null;
  voided_at: string | null;
}

export interface RecipientRow {
  contract_id: string;
  created_at: string;
  decline_reason: string | null;
  declined_at: string | null;
  email: string;
  id: string;
  initials_image: string | null;
  last_reminded_at: string | null;
  name: string;
  notified_at: string | null;
  routing_order: number;
  signature_image: string | null;
  signed_at: string | null;
  signed_ip: string | null;
  signed_user_agent: string | null;
  status: "declined" | "pending" | "sent" | "signed" | "viewed";
  token_hash: string | null;
  token_nonce: string | null;
  viewed_at: string | null;
}

export interface FieldRow {
  contract_id: string;
  height: number;
  id: string;
  label: string | null;
  page: number;
  recipient_id: string;
  required: number;
  type: "date_signed" | "initials" | "name" | "signature" | "text";
  value: string | null;
  width: number;
  x: number;
  y: number;
}

export interface EventRow {
  actor_name: string | null;
  actor_user_id: string | null;
  created_at: string;
  detail: string | null;
  id: string;
  ip: string | null;
  recipient_id: string | null;
  type: string;
  user_agent: string | null;
}

interface ContractEvent {
  actorUserId?: string | null;
  contractId: string;
  detail?: string | null;
  ip?: string | null;
  recipientId?: string | null;
  type: string;
  userAgent?: string | null;
}

const contractColumns = {
  completed_at: contracts.completedAt,
  created_at: contracts.createdAt,
  created_by: contracts.createdBy,
  document_filename: contracts.documentFilename,
  document_object_key: contracts.documentObjectKey,
  document_page_count: contracts.documentPageCount,
  document_sha256: contracts.documentSha256,
  document_size: contracts.documentSize,
  due_date: contracts.dueDate,
  final_object_key: contracts.finalObjectKey,
  final_sha256: contracts.finalSha256,
  id: contracts.id,
  message: contracts.message,
  organization_id: contracts.organizationId,
  reminder_interval_days: contracts.reminderIntervalDays,
  revision: contracts.revision,
  sent_at: contracts.sentAt,
  sent_by: contracts.sentBy,
  signing_order: sql<ContractRow["signing_order"]>`${contracts.signingOrder}`,
  status: sql<ContractRow["status"]>`${contracts.status}`,
  title: contracts.title,
  updated_at: contracts.updatedAt,
  void_reason: contracts.voidReason,
  voided_at: contracts.voidedAt,
};

export const recipientColumns = {
  contract_id: contractRecipients.contractId,
  created_at: contractRecipients.createdAt,
  decline_reason: contractRecipients.declineReason,
  declined_at: contractRecipients.declinedAt,
  email: contractRecipients.email,
  id: contractRecipients.id,
  initials_image: contractRecipients.initialsImage,
  last_reminded_at: contractRecipients.lastRemindedAt,
  name: contractRecipients.name,
  notified_at: contractRecipients.notifiedAt,
  routing_order: contractRecipients.routingOrder,
  signature_image: contractRecipients.signatureImage,
  signed_at: contractRecipients.signedAt,
  signed_ip: contractRecipients.signedIp,
  signed_user_agent: contractRecipients.signedUserAgent,
  status: sql<RecipientRow["status"]>`${contractRecipients.status}`,
  token_hash: contractRecipients.tokenHash,
  token_nonce: contractRecipients.tokenNonce,
  viewed_at: contractRecipients.viewedAt,
};

export function findContract(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return getDb(database)
    .select(contractColumns)
    .from(contracts)
    .where(
      and(eq(contracts.id, id), eq(contracts.organizationId, organizationId)),
    )
    .get();
}

export function findContractById(database: D1Database, id: string) {
  return getDb(database)
    .select(contractColumns)
    .from(contracts)
    .where(eq(contracts.id, id))
    .get();
}

export function listRecipients(database: D1Database, contractId: string) {
  return getDb(database)
    .select(recipientColumns)
    .from(contractRecipients)
    .where(eq(contractRecipients.contractId, contractId))
    .orderBy(
      asc(contractRecipients.routingOrder),
      asc(contractRecipients.createdAt),
      asc(sql`${contractRecipients}.rowid`),
    );
}

export function listFields(database: D1Database, contractId: string) {
  return getDb(database)
    .select({
      contract_id: contractFields.contractId,
      height: contractFields.height,
      id: contractFields.id,
      label: contractFields.label,
      page: contractFields.page,
      recipient_id: contractFields.recipientId,
      required: contractFields.required,
      type: sql<FieldRow["type"]>`${contractFields.type}`,
      value: contractFields.value,
      width: contractFields.width,
      x: contractFields.x,
      y: contractFields.y,
    })
    .from(contractFields)
    .where(eq(contractFields.contractId, contractId))
    .orderBy(
      asc(contractFields.page),
      asc(contractFields.y),
      asc(contractFields.x),
    );
}

export function listEvents(database: D1Database, contractId: string) {
  return getDb(database)
    .select({
      actor_name: user.name,
      actor_user_id: contractEvents.actorUserId,
      created_at: contractEvents.createdAt,
      detail: contractEvents.detail,
      id: contractEvents.id,
      ip: contractEvents.ip,
      recipient_id: contractEvents.recipientId,
      type: contractEvents.type,
      user_agent: contractEvents.userAgent,
    })
    .from(contractEvents)
    .leftJoin(user, eq(user.id, contractEvents.actorUserId))
    .where(eq(contractEvents.contractId, contractId))
    .orderBy(asc(contractEvents.createdAt), asc(sql`${contractEvents}.rowid`));
}

/**
 * Selects `row` as constants from the contract while `when` holds, so an
 * INSERT ... SELECT lands only under that condition. As Drizzle inserts every
 * column, `row` lists each one in the table's order.
 */
export function rowWhen<T extends Record<string, unknown>>(
  database: D1Database,
  contractId: string,
  row: T,
  when: SQL | undefined,
) {
  const fields = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, sql`${value}`.as(key)]),
  ) as { [Key in keyof T]: SQL.Aliased };
  return getDb(database)
    .select(fields)
    .from(contracts)
    .where(and(eq(contracts.id, contractId), when));
}

/**
 * Runs write statements as one D1 batch. Drizzle types a batch as a tuple
 * with a known first statement, which a leading spread cannot provide.
 */
export function batchWrites(
  database: D1Database,
  statements: BatchItem<"sqlite">[],
): Promise<D1Result[]> {
  return getDb(database).batch(
    statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  );
}

/**
 * Inserts an audit event; with `when`, only if that SQL condition holds, so
 * it can share a batch with the change it records.
 */
export function eventStatement(
  database: D1Database,
  event: ContractEvent,
  when?: SQL,
) {
  const row = {
    id: crypto.randomUUID(),
    contractId: event.contractId,
    recipientId: event.recipientId ?? null,
    actorUserId: event.actorUserId ?? null,
    type: event.type,
    detail: event.detail?.slice(0, 500) ?? null,
    ip: event.ip ?? null,
    userAgent: event.userAgent?.slice(0, 300) ?? null,
    createdAt: new Date().toISOString(),
  };
  const insert = getDb(database).insert(contractEvents);
  return when
    ? insert.select(rowWhen(database, event.contractId, row, when))
    : insert.values(row);
}

export async function recordEvent(database: D1Database, event: ContractEvent) {
  await eventStatement(database, event).run();
}

/** The organization and sender that emails about a contract come from. */
export async function mailFor(
  database: D1Database,
  contract: ContractRow,
): Promise<ContractMail> {
  const row = await getDb(database)
    .select({
      organization_name: organization.name,
      sender_email: user.email,
      sender_name: user.name,
    })
    .from(organization)
    .leftJoin(
      user,
      sql`${user.id} = ${contract.sent_by ?? contract.created_by}`,
    )
    .where(eq(organization.id, contract.organization_id))
    .get();
  return {
    contractId: contract.id,
    dueDate: contract.due_date,
    message: contract.message,
    organizationName: row?.organization_name ?? "Tearleads",
    sender:
      row?.sender_email && row.sender_name
        ? { email: row.sender_email, name: row.sender_name }
        : null,
    title: contract.title,
  };
}

/**
 * The signing link for a recipient who has been sent one. Links derive from
 * BETTER_AUTH_SECRET, so after it rotates the stored hash is refreshed and
 * the re-sent link opens while the old one no longer does.
 */
async function recipientLink(
  environment: ContractEnvironment,
  recipient: Pick<RecipientRow, "id" | "token_hash" | "token_nonce">,
) {
  if (!recipient.token_nonce) return null;
  const token = await signingToken(
    environment.BETTER_AUTH_SECRET,
    recipient.id,
    recipient.token_nonce,
  );
  const hash = await signingTokenHash(token);
  if (hash !== recipient.token_hash) {
    await getDb(environment.DB)
      .update(contractRecipients)
      .set({ tokenHash: hash })
      .where(
        and(
          eq(contractRecipients.id, recipient.id),
          eq(contractRecipients.tokenNonce, recipient.token_nonce),
        ),
      );
  }
  return signingUrl(environment, token);
}

/**
 * Emails each recipient their signing link, issuing it on first notice, and
 * records delivery. Returns how many emails were accepted for delivery.
 */
export async function notifyRecipients(
  environment: ContractEnvironment,
  contract: ContractRow,
  recipients: RecipientRow[],
  reminder: boolean,
  at = new Date(),
) {
  const database = environment.DB;
  const db = getDb(database);
  const mail = await mailFor(database, contract);
  const now = at.toISOString();
  let delivered = 0;
  for (const recipient of recipients) {
    let link: string | null;
    if (!recipient.token_nonce) {
      const nonce = newTokenNonce();
      const token = await signingToken(
        environment.BETTER_AUTH_SECRET,
        recipient.id,
        nonce,
      );
      const issued = await db
        .update(contractRecipients)
        .set({
          notifiedAt: now,
          status: "sent",
          tokenHash: await signingTokenHash(token),
          tokenNonce: nonce,
        })
        .where(
          and(
            eq(contractRecipients.id, recipient.id),
            eq(contractRecipients.status, "pending"),
          ),
        );
      if (issued.meta.changes !== 1) continue;
      link = signingUrl(environment, token);
    } else {
      if (reminder) {
        await db
          .update(contractRecipients)
          .set({ lastRemindedAt: now })
          .where(eq(contractRecipients.id, recipient.id));
      }
      link = await recipientLink(environment, recipient);
    }
    if (!link) continue;
    try {
      await sendSigningRequest(environment, mail, recipient, link, reminder);
      delivered += 1;
      await recordEvent(database, {
        contractId: contract.id,
        recipientId: recipient.id,
        type: reminder ? "reminded" : "notified",
      });
    } catch (cause) {
      await recordDeliveryFailure(database, contract.id, recipient.id, cause);
    }
  }
  return delivered;
}

/**
 * After a signature, sends the next signers their links in sequential
 * contracts, or completes the contract once everyone has signed.
 */
export async function advanceContract(
  environment: ContractEnvironment,
  contractId: string,
) {
  const contract = await findContractById(environment.DB, contractId);
  if (contract?.status !== "sent") return false;
  const recipients = await listRecipients(environment.DB, contract.id);
  if (
    recipients.length > 0 &&
    recipients.every(({ status }) => status === "signed")
  ) {
    return completeContract(environment, contract, recipients);
  }
  const awaiting = recipients.filter(
    ({ status }) => status === "sent" || status === "viewed",
  );
  const pending = recipients.filter(({ status }) => status === "pending");
  if (awaiting.length === 0 && pending.length > 0) {
    const next = Math.min(...pending.map(({ routing_order }) => routing_order));
    await notifyRecipients(
      environment,
      contract,
      pending.filter(({ routing_order }) => routing_order === next),
      false,
    );
  }
  return false;
}

/** The signers whose turn it is in a newly sent contract. */
export function firstSigners(
  contract: Pick<ContractRow, "signing_order">,
  recipients: RecipientRow[],
) {
  if (contract.signing_order === "parallel" || recipients.length === 0) {
    return recipients;
  }
  const first = Math.min(
    ...recipients.map(({ routing_order }) => routing_order),
  );
  return recipients.filter(({ routing_order }) => routing_order === first);
}

/**
 * Stamps the signed PDF, stores it, marks the contract completed exactly once,
 * and emails everyone a copy.
 */
async function completeContract(
  environment: ContractEnvironment,
  contract: ContractRow,
  recipients: RecipientRow[],
) {
  const database = environment.DB;
  const original = await environment.STORAGE.get(contract.document_object_key);
  if (!original) throw new Error("The contract document is missing.");
  const [fields, events, mail] = await Promise.all([
    listFields(database, contract.id),
    listEvents(database, contract.id),
    mailFor(database, contract),
  ]);
  const completedAt = new Date().toISOString();
  const signed = await stampContract(
    new Uint8Array(await original.arrayBuffer()),
    stampedFields(fields, recipients, completedAt),
    certificateFor(contract, recipients, events, mail, completedAt),
  );
  // A unique key per attempt: if two last signatures race, the loser's copy
  // is discarded rather than overwriting the winner's recorded hash.
  const finalKey = `organizations/${contract.organization_id}/contracts/${contract.id}/signed-${crypto.randomUUID()}.pdf`;
  await environment.STORAGE.put(finalKey, signed, {
    customMetadata: {
      contractId: contract.id,
      organizationId: contract.organization_id,
    },
    httpMetadata: { contentType: "application/pdf" },
  });
  const completed = await getDb(database)
    .update(contracts)
    .set({
      completedAt,
      finalObjectKey: finalKey,
      finalSha256: await sha256Hex(signed),
      status: "completed",
      updatedAt: completedAt,
    })
    .where(and(eq(contracts.id, contract.id), eq(contracts.status, "sent")));
  if (completed.meta.changes !== 1) {
    await environment.STORAGE.delete(finalKey);
    return false;
  }
  await recordEvent(database, { contractId: contract.id, type: "completed" });
  await deliverCompletion(environment, contract, recipients, mail, signed);
  return true;
}

/** What to draw for each field: adopted images, dates, names, and text. */
function stampedFields(
  fields: FieldRow[],
  recipients: RecipientRow[],
  completedAt: string,
) {
  const byId = new Map(
    recipients.map((recipient) => [recipient.id, recipient]),
  );
  const images = new Map<string, Uint8Array>();
  const imageFor = (dataUrl: string | null) => {
    if (!dataUrl) return undefined;
    const image = images.get(dataUrl) ?? decodePngDataUrl(dataUrl);
    if (!image) return undefined;
    images.set(dataUrl, image);
    return image;
  };
  return fields.flatMap((field): StampedField[] => {
    const signer = byId.get(field.recipient_id);
    if (!signer) return [];
    const rect = {
      height: field.height,
      width: field.width,
      x: field.x,
      y: field.y,
    };
    if (field.type === "signature" || field.type === "initials") {
      const image = imageFor(
        field.type === "signature"
          ? signer.signature_image
          : signer.initials_image,
      );
      return [{ image, page: field.page, rect }];
    }
    const text =
      field.type === "date_signed"
        ? formatSignedDate(signer.signed_at ?? completedAt)
        : field.type === "name"
          ? signer.name
          : (field.value ?? "");
    return text ? [{ page: field.page, rect, text }] : [];
  });
}

function certificateFor(
  contract: ContractRow,
  recipients: RecipientRow[],
  events: EventRow[],
  mail: ContractMail,
  completedAt: string,
): Certificate {
  const byId = new Map(
    recipients.map((recipient) => [recipient.id, recipient]),
  );
  return {
    completedAt,
    contractId: contract.id,
    documentFilename: contract.document_filename,
    documentPageCount: contract.document_page_count,
    documentSha256: contract.document_sha256,
    events: [
      ...events.map((event) => ({
        at: event.created_at,
        description: describeEvent(event, byId),
      })),
      { at: completedAt, description: "Completed: every signer has signed" },
    ],
    organizationName: mail.organizationName,
    sentAt: contract.sent_at ?? completedAt,
    signers: recipients.map((recipient) => ({
      email: recipient.email,
      ip: recipient.signed_ip,
      name: recipient.name,
      signedAt: recipient.signed_at ?? completedAt,
      userAgent: recipient.signed_user_agent,
    })),
    title: contract.title,
  };
}

/**
 * Emails the signed PDF to each signer, with their own link back to it, and
 * to the sender when they did not sign.
 */
async function deliverCompletion(
  environment: ContractEnvironment,
  contract: ContractRow,
  recipients: RecipientRow[],
  mail: ContractMail,
  signed: Uint8Array,
) {
  const filename = signedFilename(contract.document_filename);
  const deliveries: Array<{
    link: string | null;
    person: { email: string; name: string };
    recipientId: string | null;
  }> = [];
  for (const recipient of recipients) {
    deliveries.push({
      link: await recipientLink(environment, recipient),
      person: recipient,
      recipientId: recipient.id,
    });
  }
  const sender = mail.sender;
  if (
    sender &&
    !recipients.some(
      ({ email }) => email.toLowerCase() === sender.email.toLowerCase(),
    )
  ) {
    deliveries.push({
      link: contractUrl(environment, contract.id),
      person: sender,
      recipientId: null,
    });
  }
  for (const { link, person, recipientId } of deliveries) {
    if (!link) continue;
    try {
      await sendCompletion(environment, mail, person, link, signed, filename);
    } catch (cause) {
      await recordDeliveryFailure(
        environment.DB,
        contract.id,
        recipientId,
        cause,
      );
    }
  }
}

async function recordDeliveryFailure(
  database: D1Database,
  contractId: string,
  recipientId: string | null,
  cause: unknown,
) {
  console.error("Contract email could not be sent.", cause);
  await recordEvent(database, {
    contractId,
    detail: cause instanceof Error ? cause.message : null,
    recipientId,
    type: "delivery_failed",
  });
}

/** A readable audit line for the certificate. */
function describeEvent(
  event: EventRow,
  recipients: Map<string, Pick<RecipientRow, "email" | "name">>,
) {
  const recipient = event.recipient_id
    ? recipients.get(event.recipient_id)
    : undefined;
  const who = recipient ? `${recipient.name} <${recipient.email}>` : "a signer";
  const actor = event.actor_name ?? "an organization member";
  switch (event.type) {
    case "created":
      return `Created by ${actor}`;
    case "sent":
      return `Sent for signature by ${actor}`;
    case "notified":
      return `Signing request emailed to ${who}`;
    case "reminded":
      return `Reminder emailed to ${who}`;
    case "viewed":
      return `Viewed by ${who}${event.ip ? ` from ${event.ip}` : ""}`;
    case "signed":
      return `Signed by ${who}${event.ip ? ` from ${event.ip}` : ""}`;
    case "declined":
      return `Declined by ${who}`;
    case "voided":
      return `Voided by ${actor}`;
    case "delivery_failed":
      return `Email to ${who} could not be delivered`;
    default:
      return event.type;
  }
}

/** Decodes a signature adopted as a PNG data URL, or null if it is not one. */
export function decodePngDataUrl(value: string) {
  const prefix = "data:image/png;base64,";
  if (!value.startsWith(prefix)) return null;
  try {
    const binary = atob(value.slice(prefix.length));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((byte, index) => bytes[index] === byte)
      ? bytes
      : null;
  } catch {
    return null;
  }
}

function formatSignedDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function signedFilename(filename: string) {
  const base = filename.replace(/\.pdf$/i, "");
  return `${base} (signed).pdf`;
}
