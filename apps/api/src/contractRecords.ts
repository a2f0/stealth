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

const contractColumns = `id, organization_id, title, message, status, signing_order,
  due_date, reminder_interval_days, document_object_key, document_filename,
  document_size, document_sha256, document_page_count, final_object_key,
  final_sha256, created_by, sent_by, created_at, updated_at, sent_at,
  completed_at, voided_at, void_reason`;

export function findContract(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT ${contractColumns} FROM contracts
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<ContractRow>();
}

export function findContractById(database: D1Database, id: string) {
  return database
    .prepare(`SELECT ${contractColumns} FROM contracts WHERE id = ?`)
    .bind(id)
    .first<ContractRow>();
}

export async function listRecipients(database: D1Database, contractId: string) {
  const result = await database
    .prepare(
      `SELECT id, contract_id, name, email, routing_order, status, token_nonce,
              notified_at, last_reminded_at, viewed_at, signed_at, signed_ip,
              signed_user_agent, signature_image, initials_image, declined_at,
              decline_reason, created_at
       FROM contract_recipients WHERE contract_id = ?
       ORDER BY routing_order ASC, created_at ASC, rowid ASC`,
    )
    .bind(contractId)
    .all<RecipientRow>();
  return result.results;
}

export async function listFields(database: D1Database, contractId: string) {
  const result = await database
    .prepare(
      `SELECT id, contract_id, recipient_id, type, page, x, y, width, height,
              required, label, value
       FROM contract_fields WHERE contract_id = ?
       ORDER BY page ASC, y ASC, x ASC`,
    )
    .bind(contractId)
    .all<FieldRow>();
  return result.results;
}

export async function listEvents(database: D1Database, contractId: string) {
  const result = await database
    .prepare(
      `SELECT event.id, event.recipient_id, event.actor_user_id, event.type,
              event.detail, event.ip, event.user_agent, event.created_at,
              actor.name AS actor_name
       FROM contract_events AS event
       LEFT JOIN user AS actor ON actor.id = event.actor_user_id
       WHERE event.contract_id = ?
       ORDER BY event.created_at ASC, event.rowid ASC`,
    )
    .bind(contractId)
    .all<EventRow>();
  return result.results;
}

export function eventStatement(database: D1Database, event: ContractEvent) {
  return database
    .prepare(
      `INSERT INTO contract_events
         (id, contract_id, recipient_id, actor_user_id, type, detail, ip,
          user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      event.contractId,
      event.recipientId ?? null,
      event.actorUserId ?? null,
      event.type,
      event.detail?.slice(0, 500) ?? null,
      event.ip ?? null,
      event.userAgent?.slice(0, 300) ?? null,
      new Date().toISOString(),
    );
}

export async function recordEvent(database: D1Database, event: ContractEvent) {
  await eventStatement(database, event).run();
}

/** The organization and sender that emails about a contract come from. */
export async function mailFor(
  database: D1Database,
  contract: ContractRow,
): Promise<ContractMail> {
  const row = await database
    .prepare(
      `SELECT organization.name AS organization_name,
              sender.name AS sender_name, sender.email AS sender_email
       FROM organization
       LEFT JOIN user AS sender ON sender.id = ?
       WHERE organization.id = ?`,
    )
    .bind(contract.sent_by ?? contract.created_by, contract.organization_id)
    .first<{
      organization_name: string;
      sender_email: string | null;
      sender_name: string | null;
    }>();
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

/** The signing link for a recipient who has been sent one. */
async function recipientLink(
  environment: ContractEnvironment,
  recipient: Pick<RecipientRow, "id" | "token_nonce">,
) {
  if (!recipient.token_nonce) return null;
  return signingUrl(
    environment,
    await signingToken(
      environment.BETTER_AUTH_SECRET,
      recipient.id,
      recipient.token_nonce,
    ),
  );
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
  const mail = await mailFor(database, contract);
  const now = at.toISOString();
  let delivered = 0;
  for (const recipient of recipients) {
    let nonce = recipient.token_nonce;
    if (!nonce) {
      nonce = newTokenNonce();
      const token = await signingToken(
        environment.BETTER_AUTH_SECRET,
        recipient.id,
        nonce,
      );
      const issued = await database
        .prepare(
          `UPDATE contract_recipients
           SET status = 'sent', token_nonce = ?, token_hash = ?,
               notified_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(nonce, await signingTokenHash(token), now, recipient.id)
        .run();
      if (issued.meta.changes !== 1) continue;
    } else if (reminder) {
      await database
        .prepare(
          `UPDATE contract_recipients SET last_reminded_at = ? WHERE id = ?`,
        )
        .bind(now, recipient.id)
        .run();
    }
    const link = await recipientLink(environment, {
      id: recipient.id,
      token_nonce: nonce,
    });
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
  if (recipients.every(({ status }) => status === "signed")) {
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
  const completed = await database
    .prepare(
      `UPDATE contracts
       SET status = 'completed', completed_at = ?, final_object_key = ?,
           final_sha256 = ?, updated_at = ?
       WHERE id = ? AND status = 'sent'`,
    )
    .bind(
      completedAt,
      finalKey,
      await sha256Hex(signed),
      completedAt,
      contract.id,
    )
    .run();
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
