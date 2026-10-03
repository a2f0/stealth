import type { BadgeTone, IconName } from "@tearleads/ui/react";
import type {
  ContractEvent,
  ContractStatus,
  FieldBox,
  FieldType,
  RecipientStatus,
} from "./contractsApi";

/** Field kinds in toolbar order, with their default size in PDF points. */
export const fieldTypes: Array<{
  height: number;
  icon: IconName;
  label: string;
  type: FieldType;
  width: number;
}> = [
  {
    height: 44,
    icon: "signature",
    label: "Signature",
    type: "signature",
    width: 180,
  },
  { height: 40, icon: "edit", label: "Initials", type: "initials", width: 64 },
  {
    height: 22,
    icon: "calendar",
    label: "Date signed",
    type: "date_signed",
    width: 120,
  },
  {
    height: 22,
    icon: "organization",
    label: "Full name",
    type: "name",
    width: 170,
  },
  { height: 22, icon: "type", label: "Text", type: "text", width: 170 },
];

export function fieldTypeLabel(type: FieldType) {
  return fieldTypes.find((field) => field.type === type)?.label ?? type;
}

/**
 * A new field's box, centred where the page was clicked and kept on the page.
 * `x` and `y` are the click as fractions of the page; the page size is in
 * PDF points as displayed.
 */
export function placeNewField(
  type: FieldType,
  page: number,
  click: { x: number; y: number },
  pageSize: { height: number; width: number },
): FieldBox {
  const kind = fieldTypes.find((field) => field.type === type) ?? fieldTypes[0];
  const width = Math.min(1, (kind?.width ?? 180) / pageSize.width);
  const height = Math.min(1, (kind?.height ?? 44) / pageSize.height);
  return clampBox({
    height,
    page,
    width,
    x: click.x - width / 2,
    y: click.y - height / 2,
  });
}

/** Keeps a box entirely on its page. */
export function clampBox(box: FieldBox): FieldBox {
  const width = Math.min(Math.max(box.width, 0.01), 1);
  const height = Math.min(Math.max(box.height, 0.01), 1);
  return {
    height,
    page: box.page,
    width,
    x: round(Math.min(Math.max(box.x, 0), 1 - width)),
    y: round(Math.min(Math.max(box.y, 0), 1 - height)),
  };
}

/** Moves a box by fractions of its page, keeping it on the page. */
export function nudgeBox(box: FieldBox, dx: number, dy: number): FieldBox {
  return clampBox({ ...box, x: box.x + dx, y: box.y + dy });
}

/** Rounds down, so rounding never pushes a box past the page edge. */
function round(value: number) {
  return Math.floor(value * 10_000) / 10_000;
}

/** Signers are told apart by colour on the document; the palette repeats. */
export function recipientTone(index: number) {
  return `recipientTone${index % 6}`;
}

export function isOverdue(
  contract: { dueDate: string | null; status: ContractStatus },
  today = localDate(),
) {
  return (
    contract.status === "sent" &&
    contract.dueDate !== null &&
    contract.dueDate < today
  );
}

export function contractStatus(
  contract: { dueDate: string | null; status: ContractStatus },
  today = localDate(),
): { label: string; tone: BadgeTone } {
  if (isOverdue(contract, today)) return { label: "Overdue", tone: "warning" };
  switch (contract.status) {
    case "draft":
      return { label: "Draft", tone: "neutral" };
    case "sent":
      return { label: "Waiting for signatures", tone: "info" };
    case "completed":
      return { label: "Completed", tone: "success" };
    case "declined":
      return { label: "Declined", tone: "danger" };
    default:
      return { label: "Voided", tone: "neutral" };
  }
}

export function recipientStatus(status: RecipientStatus): {
  label: string;
  tone: BadgeTone;
} {
  switch (status) {
    case "pending":
      return { label: "Waiting for turn", tone: "neutral" };
    case "sent":
      return { label: "Sent", tone: "info" };
    case "viewed":
      return { label: "Viewed", tone: "info" };
    case "signed":
      return { label: "Signed", tone: "success" };
    default:
      return { label: "Declined", tone: "danger" };
  }
}

export const reminderOptions: Array<{ label: string; value: number | null }> = [
  { label: "No reminders", value: null },
  { label: "Every day", value: 1 },
  { label: "Every 2 days", value: 2 },
  { label: "Every 3 days", value: 3 },
  { label: "Every week", value: 7 },
];

export type ContractFilter =
  | "all"
  | "closed"
  | "completed"
  | "draft"
  | "waiting";

export const contractFilters: Array<{ label: string; value: ContractFilter }> =
  [
    { label: "All", value: "all" },
    { label: "Waiting", value: "waiting" },
    { label: "Drafts", value: "draft" },
    { label: "Completed", value: "completed" },
    { label: "Declined or voided", value: "closed" },
  ];

export function matchesFilter(status: ContractStatus, filter: ContractFilter) {
  if (filter === "all") return true;
  if (filter === "waiting") return status === "sent";
  if (filter === "closed") return status === "declined" || status === "voided";
  return status === filter;
}

/** "Sam Signer" → "SS"; the default for typed initials. */
export function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3);
}

/** A readable line for a contract's activity list. */
export function describeContractEvent(
  event: ContractEvent,
  recipientNames: Map<string, string>,
) {
  const who =
    (event.recipientId && recipientNames.get(event.recipientId)) || "A signer";
  const actor = event.actorName ?? "Someone";
  switch (event.type) {
    case "created_from_template":
      return `${actor} created it from ${event.detail ?? "a template"}`;
    case "created":
      return `${actor} uploaded the document`;
    case "sent":
      return `${actor} sent it for signature`;
    case "notified":
      return `Signing request emailed to ${who}`;
    case "reminded":
      return `Reminder emailed to ${who}`;
    case "viewed":
      return `${who} opened it`;
    case "signed":
      return `${who} signed`;
    case "declined":
      return event.detail
        ? `${who} declined: “${event.detail}”`
        : `${who} declined`;
    case "voided":
      return event.detail
        ? `${actor} voided it: “${event.detail}”`
        : `${actor} voided it`;
    case "completed":
      return "Everyone signed; the signed copy was emailed to all parties";
    case "delivery_failed":
      return `An email to ${who} could not be delivered`;
    default:
      return event.type;
  }
}

/** Today in the viewer's time zone, as YYYY-MM-DD. */
export function localDate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}
