import { and, desc, eq, exists, lte, ne, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { normalizeBusinessDate } from "./businesses";
import { sendVoided } from "./contractMail";
import { InvalidPdfError, inspectPdf, sha256Hex } from "./contractPdf";
import {
  batchWrites,
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
  rowWhen,
} from "./contractRecords";
import { getDb } from "./db";
import { normalizeFilename } from "./filenames";
import {
  contractFields,
  contractRecipients,
  contracts as contractsTable,
  deletedObjectCleanup,
  user,
} from "./schema";
import type { Bindings } from "./types";

type ContractEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type ContractContext = Context<ContractEnv>;

// Stamping holds the document in memory several times over, so this stays
// well inside a Worker's memory limit.
const maxDocumentBytes = 10 * 1024 * 1024;
const manualReminderGapMs = 60 * 60 * 1000;
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
  const db = getDb(context.env.DB);
  const recipientOf = eq(contractRecipients.contractId, contractsTable.id);
  const rows: SummaryRow[] = await db
    .select({
      completed_at: contractsTable.completedAt,
      created_at: contractsTable.createdAt,
      due_date: contractsTable.dueDate,
      id: contractsTable.id,
      sender_name: user.name,
      sent_at: contractsTable.sentAt,
      signed_count: db.$count(
        contractRecipients,
        and(recipientOf, eq(contractRecipients.status, "signed")),
      ),
      signer_count: db.$count(contractRecipients, recipientOf),
      status: sql<ContractRow["status"]>`${contractsTable.status}`,
      title: contractsTable.title,
      updated_at: contractsTable.updatedAt,
    })
    .from(contractsTable)
    .leftJoin(
      user,
      eq(
        user.id,
        sql`coalesce(${contractsTable.sentBy}, ${contractsTable.createdBy})`,
      ),
    )
    .where(eq(contractsTable.organizationId, context.get("organizationId")))
    .orderBy(desc(contractsTable.updatedAt), desc(contractsTable.id));
  return context.json({ contracts: rows.map(toSummary) });
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
    return context.json({ error: "Contracts must be 10 MB or smaller." }, 413);
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
  const db = getDb(context.env.DB);
  try {
    await db.batch([
      db.insert(contractsTable).values({
        createdAt: now,
        createdBy: userId,
        documentFilename: filename,
        documentObjectKey: objectKey,
        documentPageCount: pageCount,
        documentSha256: await sha256Hex(bytes),
        documentSize: bytes.byteLength,
        id,
        organizationId,
        title,
        updatedAt: now,
      }),
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
  const saved = await getDb(context.env.DB).batch(
    draftStatements(context.env.DB, contract, draft, new Date().toISOString()),
  );
  if (saved[0]?.meta.changes !== 1) return notDraft(context);
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
  // Only the revision that was validated goes out: a save landing meanwhile
  // bumps it and this send is refused.
  const sent = await getDb(database)
    .update(contractsTable)
    .set({ sentAt: now, sentBy: userId, status: "sent", updatedAt: now })
    .where(
      and(
        eq(contractsTable.id, contract.id),
        eq(contractsTable.organizationId, organizationId),
        eq(contractsTable.status, "draft"),
        eq(contractsTable.revision, contract.revision),
      ),
    );
  if (sent.meta.changes !== 1) {
    return context.json(
      { error: "The draft changed while it was being sent. Send it again." },
      409,
    );
  }
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
  // At most one manual reminder an hour per signer, to protect the sender's
  // reputation and the signers' inboxes. Each signer is claimed first, so a
  // double click cannot email anyone twice.
  const now = new Date();
  const threshold = new Date(now.getTime() - manualReminderGapMs);
  const due: typeof awaiting = [];
  for (const recipient of awaiting) {
    const claim = await getDb(database)
      .update(contractRecipients)
      .set({ lastRemindedAt: now.toISOString() })
      .where(
        and(
          eq(contractRecipients.id, recipient.id),
          lte(
            sql`coalesce(${contractRecipients.lastRemindedAt}, ${contractRecipients.notifiedAt})`,
            threshold.toISOString(),
          ),
        ),
      );
    if (claim.meta.changes === 1) due.push(recipient);
  }
  if (awaiting.length > 0 && due.length === 0) {
    return context.json(
      { error: "Signers were emailed within the last hour. Try again later." },
      429,
    );
  }
  const reminded = await notifyRecipients(
    context.env,
    contract,
    due,
    true,
    now,
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
  const voided = await getDb(database)
    .update(contractsTable)
    .set({
      status: "voided",
      updatedAt: now,
      voidReason: reason || null,
      voidedAt: now,
    })
    .where(
      and(
        eq(contractsTable.id, contract.id),
        eq(contractsTable.organizationId, organizationId),
        eq(contractsTable.status, "sent"),
      ),
    );
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
// for the deleted-object cleanup in the same batch, under the same condition,
// so a delete racing a send never queues a live document.
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
  const db = getDb(database);
  const deletable = and(
    eq(contractsTable.organizationId, organizationId),
    ne(contractsTable.status, "sent"),
  );
  const stillDeletable = exists(
    db
      .select({ one: sql`1` })
      .from(contractsTable)
      .where(and(eq(contractsTable.id, contract.id), deletable)),
  );
  // Each file is queued as INSERT OR REPLACE would: rows holding its id or
  // object key are removed, then its row is inserted.
  const deleted = await batchWrites(database, [
    ...keys.flatMap(([kind, key]) => {
      const id = `${kind}:${contract.id}`;
      return [
        db
          .delete(deletedObjectCleanup)
          .where(
            and(
              or(
                eq(deletedObjectCleanup.id, id),
                eq(deletedObjectCleanup.objectKey, key),
              ),
              stillDeletable,
            ),
          ),
        db.insert(deletedObjectCleanup).select(
          rowWhen(
            database,
            contract.id,
            {
              id,
              organizationId,
              objectKey: key,
              deletedAt: now,
              cleanupToken: null,
              cleanupClaimedAt: null,
            },
            deletable,
          ),
        ),
      ];
    }),
    db
      .delete(contractsTable)
      .where(and(eq(contractsTable.id, contract.id), deletable)),
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
  const [recipients, fields, events, createdBy, sentBy] = await Promise.all([
    listRecipients(database, contract.id),
    listFields(database, contract.id),
    listEvents(database, contract.id),
    userName(database, contract.created_by),
    userName(database, contract.sent_by),
  ]);
  return {
    completedAt: contract.completed_at,
    createdAt: contract.created_at,
    createdByName: createdBy?.name ?? null,
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
    sentByName: sentBy?.name ?? null,
    signingOrder: contract.signing_order,
    status: contract.status,
    title: contract.title,
    updatedAt: contract.updated_at,
    voidReason: contract.void_reason,
    voidedAt: contract.voided_at,
  };
}

/** A user's name, if there is such a user. */
function userName(database: D1Database, id: string | null) {
  if (id === null) return undefined;
  return getDb(database)
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, id))
    .get();
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
    if (email && emails.has(email))
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
  // Drafts save as they are edited, so a signer may be half filled in;
  // sending requires a name and a valid email.
  if (name.length > 120) return "Signer names can be up to 120 characters.";
  if (email.length > 254) return "Signer emails can be up to 254 characters.";
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
  if (recipients.some(({ name }) => !name)) return "Every signer needs a name.";
  const unreachable = recipients.find(({ email }) => !validEmail(email));
  if (unreachable) return `“${unreachable.name}” needs a valid email address.`;
  const unsigned = recipients.find(
    (recipient) =>
      !fields.some(
        (field) =>
          field.recipient_id === recipient.id && field.type === "signature",
      ),
  );
  return unsigned ? `Place a signature field for ${unsigned.name}.` : null;
}

/** A new signer's columns after their details, as the table defaults them. */
const unsentRecipient = {
  status: "pending",
  tokenNonce: null,
  tokenHash: null,
  notifiedAt: null,
  lastRemindedAt: null,
  viewedAt: null,
  signedAt: null,
  signedIp: null,
  signedUserAgent: null,
  signatureImage: null,
  initialsImage: null,
  declinedAt: null,
  declineReason: null,
};

/**
 * The statements that replace a draft's details, signers, and fields. Each
 * re-checks that the contract is still a draft, so a save racing a send
 * cannot replace the recipients who were just emailed.
 */
function draftStatements(
  database: D1Database,
  contract: ContractRow,
  draft: Draft,
  now: string,
) {
  const db = getDb(database);
  const recipientIds = new Map(
    draft.recipients.map((recipient) => [recipient.key, crypto.randomUUID()]),
  );
  const isDraft = eq(contractsTable.status, "draft");
  const stillDraft = exists(
    db
      .select({ one: sql`1` })
      .from(contractsTable)
      .where(and(eq(contractsTable.id, contract.id), isDraft)),
  );
  return [
    db
      .update(contractsTable)
      .set({
        dueDate: draft.dueDate,
        message: draft.message,
        reminderIntervalDays: draft.reminderIntervalDays,
        revision: sql`${contractsTable.revision} + 1`,
        signingOrder: draft.signingOrder,
        title: draft.title,
        updatedAt: now,
      })
      .where(
        and(
          eq(contractsTable.id, contract.id),
          eq(contractsTable.organizationId, contract.organization_id),
          isDraft,
        ),
      ),
    db
      .delete(contractFields)
      .where(and(eq(contractFields.contractId, contract.id), stillDraft)),
    db
      .delete(contractRecipients)
      .where(and(eq(contractRecipients.contractId, contract.id), stillDraft)),
    ...draft.recipients.map((recipient) =>
      db.insert(contractRecipients).select(
        rowWhen(
          database,
          contract.id,
          {
            id: recipientIds.get(recipient.key) ?? "",
            contractId: contract.id,
            organizationId: contract.organization_id,
            name: recipient.name,
            email: recipient.email,
            routingOrder:
              draft.signingOrder === "parallel" ? 1 : recipient.routingOrder,
            ...unsentRecipient,
            createdAt: now,
          },
          isDraft,
        ),
      ),
    ),
    ...draft.fields.map((field) =>
      db.insert(contractFields).select(
        rowWhen(
          database,
          contract.id,
          {
            id: crypto.randomUUID(),
            contractId: contract.id,
            recipientId: recipientIds.get(field.recipientKey) ?? "",
            type: field.type,
            page: field.page,
            x: field.x,
            y: field.y,
            width: field.width,
            height: field.height,
            required: field.required ? 1 : 0,
            label: field.label,
            value: null,
          },
          isDraft,
        ),
      ),
    ),
  ] as const;
}

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
