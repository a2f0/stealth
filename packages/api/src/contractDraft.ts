import { normalizeBusinessDate } from "./businesses";
import type { ContractRow, FieldRow } from "./contractRecords";

const maxRecipients = 20;
const maxFields = 500;
const fieldTypes = ["signature", "initials", "date_signed", "name", "text"];

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

export interface Draft {
  dueDate: string | null;
  fields: DraftField[];
  message: string;
  recipients: DraftRecipient[];
  reminderIntervalDays: number | null;
  signingOrder: "parallel" | "sequential";
  title: string;
}

/** Validates a draft save, returning a message when it is invalid. */
export function draftInput(body: unknown, pageCount: number): Draft | string {
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
  const keys = new Set<string>();
  for (const item of value) {
    const recipient = recipientInput(item);
    if (typeof recipient === "string") return recipient;
    if (keys.has(recipient.key)) return "Each signer needs a unique key.";
    keys.add(recipient.key);
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
    left < 1 &&
    top >= 0 &&
    top < 1 &&
    across > 0 &&
    down > 0 &&
    left + across <= 1.0001 &&
    top + down <= 1.0001;
  return fits ? { height: down, width: across, x: left, y: top } : null;
}

/**
 * The statements that replace a draft's details, signers, and fields. Each
 * re-checks that the contract is still a draft, so a save racing a send
 * cannot replace the recipients who were just emailed.
 */
export function draftStatements(
  database: D1Database,
  contract: Pick<ContractRow, "id" | "organization_id">,
  draft: Draft,
  now: string,
) {
  const recipientIds = new Map(
    draft.recipients.map((recipient) => [recipient.key, crypto.randomUUID()]),
  );
  const stillDraft = `EXISTS (
    SELECT 1 FROM contracts WHERE id = ? AND status = 'draft'
  )`;
  return [
    database
      .prepare(
        `UPDATE contracts
         SET title = ?, message = ?, signing_order = ?, due_date = ?,
             reminder_interval_days = ?, updated_at = ?,
             revision = revision + 1
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
        contract.organization_id,
      ),
    database
      .prepare(
        `DELETE FROM contract_fields WHERE contract_id = ? AND ${stillDraft}`,
      )
      .bind(contract.id, contract.id),
    database
      .prepare(
        `DELETE FROM contract_recipients
         WHERE contract_id = ? AND ${stillDraft}`,
      )
      .bind(contract.id, contract.id),
    ...draft.recipients.map((recipient) =>
      database
        .prepare(
          `INSERT INTO contract_recipients
             (id, contract_id, organization_id, name, email, routing_order,
              created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${stillDraft}`,
        )
        .bind(
          recipientIds.get(recipient.key) ?? "",
          contract.id,
          contract.organization_id,
          recipient.name,
          recipient.email,
          draft.signingOrder === "parallel" ? 1 : recipient.routingOrder,
          now,
          contract.id,
        ),
    ),
    ...draft.fields.map((field) =>
      database
        .prepare(
          `INSERT INTO contract_fields
             (id, contract_id, recipient_id, type, page, x, y, width, height,
              required, label)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${stillDraft}`,
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
          contract.id,
        ),
    ),
  ];
}

export function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
