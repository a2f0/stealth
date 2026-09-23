import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { normalizeBusinessDate } from "./businesses";
import { sendVoided } from "./contractMail";
import { InvalidPdfError, inspectPdf, sha256Hex } from "./contractPdf";
import {
  type ContractRow,
  type EventRow,
  eventStatement,
  type FieldRow,
  findContract,
  firstSigners,
  listEvents,
  listFields,
  listRecipients,
  mailFor,
  notifyRecipients,
  type RecipientRow,
  recordEvent,
} from "./contractRecords";
import { normalizeFilename } from "./filenames";
import type { Bindings } from "./types";

type ContractEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type ContractContext = Context<ContractEnv>;

const maxDocumentBytes = 25 * 1024 * 1024;
const maxRecipients = 20;
const maxFields = 500;
const fieldTypes = ["signature", "initials", "date_signed", "name", "text"];

interface SummaryRow {
  completed_at: string | null;
  created_at: string;
  due_date: string | null;
  id: string;
  sender_name: string | null;
  sent_at: string | null;
  signed_count: number;
  signer_count: number;
  status: ContractRow["status"];
  title: string;
  updated_at: string;
}

interface DraftRecipient {
  email: string;
  key: string;
  name: string;
  routingOrder: number;
}

interface DraftField {
  height: number;
  label: string | null;
  page: number;
  recipientKey: string;
  required: boolean;
  type: FieldRow["type"];
  width: number;
  x: number;
  y: number;
}

interface Draft {
  dueDate: string | null;
  fields: DraftField[];
  message: string;
  recipients: DraftRecipient[];
  reminderIntervalDays: number | null;
  signingOrder: "parallel" | "sequential";
  title: string;
}

const contracts = new Hono<ContractEnv>();

contracts.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT contract.id, contract.title, contract.status, contract.due_date,
            contract.created_at, contract.updated_at, contract.sent_at,
            contract.completed_at, sender.name AS sender_name,
            (SELECT COUNT(*) FROM contract_recipients AS recipient
             WHERE recipient.contract_id = contract.id) AS signer_count,
            (SELECT COUNT(*) FROM contract_recipients AS recipient
             WHERE recipient.contract_id = contract.id
               AND recipient.status = 'signed') AS signed_count
     FROM contracts AS contract
     LEFT JOIN user AS sender
       ON sender.id = COALESCE(contract.sent_by, contract.created_by)
     WHERE contract.organization_id = ?
     ORDER BY contract.updated_at DESC, contract.id DESC`,
  )
    .bind(context.get("organizationId"))
    .all<SummaryRow>();
  return context.json({ contracts: result.results.map(toSummary) });
});

// Uploads a PDF as a new draft.
contracts.post("/", async (context) => {
  const body = (await context.req.parseBody()) as {
    file?: File | string;
    title?: File | string;
  };
  const file = body.file;
  if (!(file instanceof File)) {
    return context.json({ error: "Choose a PDF to upload." }, 400);
  }
  if (file.size > maxDocumentBytes) {
    return context.json({ error: "Contracts must be 25 MB or smaller." }, 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pageCount: number;
  try {
    ({ pageCount } = await inspectPdf(bytes));
  } catch (cause) {
    if (cause instanceof InvalidPdfError) {
      return context.json({ error: cause.message }, 400);
    }
    throw cause;
  }
  const organizationId = context.get("organizationId");
  const userId = context.get("authSession").user.id;
  const id = crypto.randomUUID();
  const filename = normalizeFilename(
    file.name || "contract.pdf",
    "contract.pdf",
  );
  const suppliedTitle =
    typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const title = suppliedTitle || filename.replace(/\.pdf$/i, "") || "Contract";
  const objectKey = `organizations/${organizationId}/contracts/${id}/original.pdf`;
  const now = new Date().toISOString();
  await context.env.STORAGE.put(objectKey, bytes, {
    customMetadata: { contractId: id, organizationId },
    httpMetadata: { contentType: "application/pdf" },
  });
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO contracts
           (id, organization_id, title, document_object_key,
            document_filename, document_size, document_sha256,
            document_page_count, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        organizationId,
        title,
        objectKey,
        filename,
        bytes.byteLength,
        await sha256Hex(bytes),
        pageCount,
        userId,
        now,
        now,
      ),
      eventStatement(context.env.DB, {
        actorUserId: userId,
        contractId: id,
        type: "created",
      }),
    ]);
  } catch (cause) {
    await context.env.STORAGE.delete(objectKey);
    throw cause;
  }
  return context.json({ contract: await detailFor(context, id) }, 201);
});

contracts.get("/:id", async (context) => {
  const detail = await detailFor(context, context.req.param("id"));
  if (!detail) return contractNotFound(context);
  return context.json({ contract: detail });
});

contracts.get("/:id/document", async (context) => {
  const contract = await findContract(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!contract) return contractNotFound(context);
  return pdfResponse(
    context,
    contract.document_object_key,
    contract.document_filename,
  );
});

contracts.get("/:id/final", async (context) => {
  const contract = await findContract(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!contract?.final_object_key) return contractNotFound(context);
  return pdfResponse(
    context,
    contract.final_object_key,
    contract.document_filename.replace(/\.pdf$/i, " (signed).pdf"),
  );
});

// Replaces a draft's details, signers, and fields.
contracts.put("/:id/draft", async (context) => {
  const organizationId = context.get("organizationId");
  const contract = await findContract(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!contract) return contractNotFound(context);
  if (contract.status !== "draft") return notDraft(context);
  const draft = draftInput(
    await context.req.json().catch(() => null),
    contract.document_page_count,
  );
  if (typeof draft === "string") return context.json({ error: draft }, 400);
  const database = context.env.DB;
  const now = new Date().toISOString();
  const recipientIds = new Map(
    draft.recipients.map((recipient) => [recipient.key, crypto.randomUUID()]),
  );
  await database.batch([
    database
      .prepare(`DELETE FROM contract_fields WHERE contract_id = ?`)
      .bind(contract.id),
    database
      .prepare(`DELETE FROM contract_recipients WHERE contract_id = ?`)
      .bind(contract.id),
    database
      .prepare(
        `UPDATE contracts
         SET title = ?, message = ?, signing_order = ?, due_date = ?,
             reminder_interval_days = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'draft'`,
      )
      .bind(
        draft.title,
        draft.message,
        draft.signingOrder,
        draft.dueDate,
        draft.reminderIntervalDays,
        now,
        contract.id,
        organizationId,
      ),
    ...draft.recipients.map((recipient) =>
      database
        .prepare(
          `INSERT INTO contract_recipients
             (id, contract_id, organization_id, name, email, routing_order,
              created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          recipientIds.get(recipient.key) ?? "",
          contract.id,
          organizationId,
          recipient.name,
          recipient.email,
          draft.signingOrder === "parallel" ? 1 : recipient.routingOrder,
          now,
        ),
    ),
    ...draft.fields.map((field) =>
      database
        .prepare(
          `INSERT INTO contract_fields
             (id, contract_id, recipient_id, type, page, x, y, width, height,
              required, label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          contract.id,
          recipientIds.get(field.recipientKey) ?? "",
          field.type,
          field.page,
          field.x,
          field.y,
          field.width,
          field.height,
          field.required ? 1 : 0,
          field.label,
        ),
    ),
  ]);
  return context.json({ contract: await detailFor(context, contract.id) });
});

contracts.post("/:id/send", async (context) => {
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const contract = await findContract(
    database,
    organizationId,
    context.req.param("id"),
  );
  if (!contract) return contractNotFound(context);
  if (contract.status !== "draft") return notDraft(context);
  const [recipients, fields] = await Promise.all([
    listRecipients(database, contract.id),
    listFields(database, contract.id),
  ]);
  const problem = sendProblem(recipients, fields);
  if (problem) return context.json({ error: problem }, 400);
  const userId = context.get("authSession").user.id;
  const now = new Date().toISOString();
  const sent = await database
    .prepare(
      `UPDATE contracts
       SET status = 'sent', sent_at = ?, sent_by = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'draft'`,
    )
    .bind(now, userId, now, contract.id, organizationId)
    .run();
  if (sent.meta.changes !== 1) return notDraft(context);
  await recordEvent(database, {
    actorUserId: userId,
    contractId: contract.id,
    type: "sent",
  });
  const sending = {
    ...contract,
    sent_at: now,
    sent_by: userId,
    status: "sent" as const,
  };
  await notifyRecipients(
    context.env,
    sending,
    firstSigners(sending, recipients),
    false,
  );
  return context.json({ contract: await detailFor(context, contract.id) });
});

// Emails everyone whose turn it is again.
contracts.post("/:id/remind", async (context) => {
  const database = context.env.DB;
  const contract = await findContract(
    database,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!contract) return contractNotFound(context);
  if (contract.status !== "sent") {
    return context.json(
      { error: "Only contracts awaiting signatures can be reminded." },
      409,
    );
  }
  const awaiting = (await listRecipients(database, contract.id)).filter(
    ({ status }) => status === "sent" || status === "viewed",
  );
  const reminded = await notifyRecipients(
    context.env,
    contract,
    awaiting,
    true,
  );
  return context.json({
    contract: await detailFor(context, contract.id),
    reminded,
  });
});

contracts.post("/:id/void", async (context) => {
  const database = context.env.DB;
  const organizationId = context.get("organizationId");
  const contract = await findContract(
    database,
    organizationId,
    context.req.param("id"),
  );
  if (!contract) return contractNotFound(context);
  const input: unknown = await context.req.json().catch(() => null);
  const reasonValue =
    typeof input === "object" && input !== null
      ? Reflect.get(input, "reason")
      : "";
  const reason =
    typeof reasonValue === "string" ? reasonValue.trim().slice(0, 500) : "";
  const now = new Date().toISOString();
  const voided = await database
    .prepare(
      `UPDATE contracts
       SET status = 'voided', voided_at = ?, void_reason = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'sent'`,
    )
    .bind(now, reason || null, now, contract.id, organizationId)
    .run();
  if (voided.meta.changes !== 1) {
    return context.json(
      { error: "Only contracts awaiting signatures can be voided." },
      409,
    );
  }
  await recordEvent(database, {
    actorUserId: context.get("authSession").user.id,
    contractId: contract.id,
    detail: reason || null,
    type: "voided",
  });
  const mail = await mailFor(database, contract);
  for (const recipient of await listRecipients(database, contract.id)) {
    if (!recipient.notified_at || recipient.status === "signed") continue;
    try {
      await sendVoided(context.env, mail, recipient, reason);
    } catch (cause) {
      console.error("Void notice could not be sent.", cause);
    }
  }
  return context.json({ contract: await detailFor(context, contract.id) });
});

// Deletes a contract that is not awaiting signatures; its files are queued
// for the deleted-object cleanup in the same batch.
contracts.delete("/:id", async (context) => {
  const database = context.env.DB;
  const organizationId = context.get("organizationId");
  const contract = await findContract(
    database,
    organizationId,
    context.req.param("id"),
  );
  if (!contract) return contractNotFound(context);
  if (contract.status === "sent") {
    return context.json(
      { error: "Void this contract before deleting it." },
      409,
    );
  }
  const now = new Date().toISOString();
  const keys = [
    ["contract-document", contract.document_object_key],
    ["contract-final", contract.final_object_key],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const deleted = await database.batch([
    ...keys.map(([kind, key]) =>
      database
        .prepare(
          `INSERT OR REPLACE INTO deleted_object_cleanup
             (id, organization_id, object_key, deleted_at, cleanup_token,
              cleanup_claimed_at)
           VALUES (?, ?, ?, ?, NULL, NULL)`,
        )
        .bind(`${kind}:${contract.id}`, organizationId, key, now),
    ),
    database
      .prepare(
        `DELETE FROM contracts
         WHERE id = ? AND organization_id = ? AND status <> 'sent'`,
      )
      .bind(contract.id, organizationId),
  ]);
  // Change counts may include cascaded rows, so any change means it deleted.
  if ((deleted.at(-1)?.meta.changes ?? 0) < 1) {
    return context.json(
      { error: "Void this contract before deleting it." },
      409,
    );
  }
  return context.body(null, 204);
});

async function detailFor(context: ContractContext, id: string) {
  const database = context.env.DB;
  const contract = await findContract(
    database,
    context.get("organizationId"),
    id,
  );
  if (!contract) return null;
  const [recipients, fields, events, people] = await Promise.all([
    listRecipients(database, contract.id),
    listFields(database, contract.id),
    listEvents(database, contract.id),
    database
      .prepare(
        `SELECT
           (SELECT name FROM user WHERE id = ?) AS created_by_name,
           (SELECT name FROM user WHERE id = ?) AS sent_by_name`,
      )
      .bind(contract.created_by, contract.sent_by)
      .first<{ created_by_name: string | null; sent_by_name: string | null }>(),
  ]);
  return {
    completedAt: contract.completed_at,
    createdAt: contract.created_at,
    createdByName: people?.created_by_name ?? null,
    document: {
      filename: contract.document_filename,
      pageCount: contract.document_page_count,
      sha256: contract.document_sha256,
      size: contract.document_size,
    },
    dueDate: contract.due_date,
    events: events.map(toEvent),
    fields: fields.map(toField),
    finalSha256: contract.final_sha256,
    id: contract.id,
    message: contract.message,
    recipients: recipients.map(toRecipient),
    reminderIntervalDays: contract.reminder_interval_days,
    sentAt: contract.sent_at,
    sentByName: people?.sent_by_name ?? null,
    signingOrder: contract.signing_order,
    status: contract.status,
    title: contract.title,
    updatedAt: contract.updated_at,
    voidReason: contract.void_reason,
    voidedAt: contract.voided_at,
  };
}

/** Validates a draft save, returning a message when it is invalid. */
function draftInput(body: unknown, pageCount: number): Draft | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "The contract draft is invalid.";
  }
  const field = (name: string) => Reflect.get(body, name);
  const details = detailsInput(field);
  if (typeof details === "string") return details;
  const recipients = recipientsInput(field("recipients"));
  if (typeof recipients === "string") return recipients;
  const fields = fieldsInput(
    field("fields"),
    pageCount,
    new Set(recipients.map(({ key }) => key)),
  );
  if (typeof fields === "string") return fields;
  return { ...details, fields, recipients };
}

function detailsInput(
  field: (name: string) => unknown,
): Omit<Draft, "fields" | "recipients"> | string {
  const title = textValue(field("title"));
  if (!title || title.length > 200) {
    return "Give the contract a title of up to 200 characters.";
  }
  const message = textValue(field("message"));
  if (message.length > 2000) return "Keep the message to 2,000 characters.";
  const signingOrder = field("signingOrder");
  if (signingOrder !== "parallel" && signingOrder !== "sequential") {
    return "Choose whether signers sign in any order or one after another.";
  }
  const dueDate = dueDateValue(field("dueDate"));
  if (dueDate === undefined) return "The due date is invalid.";
  const reminderIntervalDays = reminderValue(field("reminderIntervalDays"));
  if (reminderIntervalDays === undefined) {
    return "Reminders can repeat every 1 to 30 days.";
  }
  return { dueDate, message, reminderIntervalDays, signingOrder, title };
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** A valid date, null when omitted, or undefined when invalid. */
function dueDateValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string"
    ? (normalizeBusinessDate(value) ?? undefined)
    : undefined;
}

/** Days between reminders, null for none, or undefined when invalid. */
function reminderValue(value: unknown) {
  if (value === null || value === undefined) return null;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 30
    ? value
    : undefined;
}

function recipientsInput(value: unknown): DraftRecipient[] | string {
  if (!Array.isArray(value) || value.length > maxRecipients) {
    return `Add up to ${maxRecipients} signers.`;
  }
  const recipients: DraftRecipient[] = [];
  const emails = new Set<string>();
  for (const item of value) {
    const recipient = recipientInput(item);
    if (typeof recipient === "string") return recipient;
    const email = recipient.email.toLowerCase();
    if (emails.has(email))
      return `${recipient.email} is listed more than once.`;
    emails.add(email);
    recipients.push(recipient);
  }
  return recipients;
}

function recipientInput(item: unknown): DraftRecipient | string {
  if (typeof item !== "object" || item === null) return "A signer is invalid.";
  const key = Reflect.get(item, "key");
  const name = textValue(Reflect.get(item, "name"));
  const email = textValue(Reflect.get(item, "email"));
  const routingOrder = Reflect.get(item, "routingOrder");
  if (typeof key !== "string" || !key || key.length > 100) {
    return "A signer is invalid.";
  }
  if (!name || name.length > 120) {
    return "Every signer needs a name of up to 120 characters.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return `“${name}” needs a valid email address.`;
  }
  if (
    typeof routingOrder !== "number" ||
    !Number.isInteger(routingOrder) ||
    routingOrder < 1 ||
    routingOrder > maxRecipients
  ) {
    return "A signer's signing order is invalid.";
  }
  return { email, key, name, routingOrder };
}

function fieldsInput(
  value: unknown,
  pageCount: number,
  recipientKeys: Set<string>,
): DraftField[] | string {
  if (!Array.isArray(value) || value.length > maxFields) {
    return `Place up to ${maxFields} fields.`;
  }
  const fields: DraftField[] = [];
  for (const item of value) {
    const field = fieldInput(item, pageCount, recipientKeys);
    if (typeof field === "string") return field;
    fields.push(field);
  }
  return fields;
}

function fieldInput(
  item: unknown,
  pageCount: number,
  recipientKeys: Set<string>,
): DraftField | string {
  if (typeof item !== "object" || item === null) return "A field is invalid.";
  const get = (name: string) => Reflect.get(item, name);
  const type = get("type");
  const recipientKey = get("recipientKey");
  const page = get("page");
  const label = get("label");
  if (typeof type !== "string" || !fieldTypes.includes(type)) {
    return "A field type is invalid.";
  }
  if (typeof recipientKey !== "string" || !recipientKeys.has(recipientKey)) {
    return "Every field must belong to a signer.";
  }
  if (
    typeof page !== "number" ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > pageCount
  ) {
    return "A field is on a page the document doesn't have.";
  }
  const rect = rectInput(get("x"), get("y"), get("width"), get("height"));
  if (!rect) return "A field extends past the edge of its page.";
  if (
    label !== undefined &&
    label !== null &&
    (typeof label !== "string" || label.length > 100)
  ) {
    return "A field label is invalid.";
  }
  return {
    ...rect,
    label: typeof label === "string" && label.trim() ? label.trim() : null,
    page,
    recipientKey,
    required: type === "text" ? get("required") !== false : true,
    type: type as DraftField["type"],
  };
}

/** A box within the page, as fractions of it, or null. */
function rectInput(x: unknown, y: unknown, width: unknown, height: unknown) {
  const numbers = [x, y, width, height];
  if (
    !numbers.every(
      (number): number is number =>
        typeof number === "number" && Number.isFinite(number),
    )
  ) {
    return null;
  }
  const [left, top, across, down] = numbers as [number, number, number, number];
  const fits =
    left >= 0 &&
    top >= 0 &&
    across > 0 &&
    down > 0 &&
    left + across <= 1.0001 &&
    top + down <= 1.0001;
  return fits ? { height: down, width: across, x: left, y: top } : null;
}

/** Why a draft cannot be sent yet, if anything. */
function sendProblem(recipients: RecipientRow[], fields: FieldRow[]) {
  if (recipients.length === 0) return "Add at least one signer.";
  const unsigned = recipients.find(
    (recipient) =>
      !fields.some(
        (field) =>
          field.recipient_id === recipient.id && field.type === "signature",
      ),
  );
  return unsigned ? `Place a signature field for ${unsigned.name}.` : null;
}

async function pdfResponse(
  context: ContractContext,
  key: string,
  filename: string,
) {
  const object = await context.env.STORAGE.get(key);
  if (!object)
    return context.json({ error: "The document file is missing." }, 404);
  const encoded = encodeURIComponent(filename).replaceAll("'", "%27");
  return new Response(object.body, {
    headers: {
      "content-disposition": `attachment; filename="contract.pdf"; filename*=UTF-8''${encoded}`,
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
    },
  });
}

function toSummary(row: SummaryRow) {
  return {
    completedAt: row.completed_at,
    createdAt: row.created_at,
    dueDate: row.due_date,
    id: row.id,
    senderName: row.sender_name,
    sentAt: row.sent_at,
    signedCount: row.signed_count,
    signerCount: row.signer_count,
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

function toRecipient(row: RecipientRow) {
  return {
    declineReason: row.decline_reason,
    declinedAt: row.declined_at,
    email: row.email,
    id: row.id,
    lastRemindedAt: row.last_reminded_at,
    name: row.name,
    notifiedAt: row.notified_at,
    routingOrder: row.routing_order,
    signedAt: row.signed_at,
    status: row.status,
    viewedAt: row.viewed_at,
  };
}

function toField(row: FieldRow) {
  return {
    height: row.height,
    id: row.id,
    label: row.label,
    page: row.page,
    recipientId: row.recipient_id,
    required: Boolean(row.required),
    type: row.type,
    value: row.value,
    width: row.width,
    x: row.x,
    y: row.y,
  };
}

function toEvent(row: EventRow) {
  return {
    actorName: row.actor_name,
    createdAt: row.created_at,
    detail: row.detail,
    id: row.id,
    ip: row.ip,
    recipientId: row.recipient_id,
    type: row.type,
  };
}

function contractNotFound(context: ContractContext) {
  return context.json({ error: "Contract not found." }, 404);
}

function notDraft(context: ContractContext) {
  return context.json({ error: "This contract has already been sent." }, 409);
}

export { contracts };
