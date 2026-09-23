import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { normalizeBusinessDate } from "./businesses";
import { listLinkedEmails, toLinkedEmail } from "./inboundEmailLinks";
import {
  canManageOrganization,
  listMemberDirectory,
} from "./organizationMembers";
import type { Bindings } from "./types";

type EquipmentEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type EquipmentContext = Context<EquipmentEnv>;

/** The types offered for new equipment. Adding one needs no migration. */
const equipmentTypes = ["computer", "cell_phone", "monitor"] as const;
type EquipmentType = (typeof equipmentTypes)[number];

interface EquipmentRow {
  assigned_user_id: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  created_at: string;
  email_count: number;
  id: string;
  make: string;
  model: string;
  purchase_date: string | null;
  serial_number: string | null;
  type: string;
  updated_at: string;
}

interface EquipmentInput {
  assigneeId: string | null;
  make: string;
  model: string;
  purchaseDate: string | null;
  serialNumber: string | null;
  type: EquipmentType;
}

const equipmentSelect = `
  SELECT item.id, item.type, item.make, item.model, item.serial_number,
         item.purchase_date, item.assigned_user_id, item.created_at,
         item.updated_at, assignee.name AS assignee_name,
         assignee.email AS assignee_email,
         (SELECT COUNT(*) FROM inbound_email_links AS link
          JOIN inbound_emails AS email ON email.id = link.email_id
          WHERE link.organization_id = item.organization_id
            AND link.target_type = 'equipment' AND link.target_id = item.id
            AND email.deleted_at IS NULL) AS email_count
  FROM equipment AS item
  LEFT JOIN user AS assignee ON assignee.id = item.assigned_user_id`;

// The assignee must be a current member of the organization, checked in the
// same statement as the write so a concurrent removal cannot slip past it.
const assigneeIsMember = `(? IS NULL OR EXISTS (
  SELECT 1 FROM member WHERE organizationId = ? AND userId = ?
))`;

const equipment = new Hono<EquipmentEnv>();

equipment.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const [items, members] = await Promise.all([
    context.env.DB.prepare(
      `${equipmentSelect}
       WHERE item.organization_id = ?
       ORDER BY item.created_at DESC, item.id DESC`,
    )
      .bind(organizationId)
      .all<EquipmentRow>(),
    listMemberDirectory(context.env.DB, organizationId),
  ]);
  return context.json({
    canManage: canManage(context),
    equipment: items.results.map(toEquipment),
    members,
    types: equipmentTypes,
  });
});

equipment.post("/", async (context) => {
  if (!canManage(context)) return managerRequired(context);
  const input = equipmentInput(await context.req.json().catch(() => null));
  if (!input) return invalidEquipment(context);
  const organizationId = context.get("organizationId");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `INSERT INTO equipment
       (id, organization_id, type, make, model, serial_number, purchase_date,
        assigned_user_id, created_by, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ${assigneeIsMember}`,
  )
    .bind(
      id,
      organizationId,
      input.type,
      input.make,
      input.model,
      input.serialNumber,
      input.purchaseDate,
      input.assigneeId,
      context.get("authSession").user.id,
      now,
      now,
      input.assigneeId,
      organizationId,
      input.assigneeId,
    )
    .run();
  if (result.meta.changes !== 1) return assigneeNotMember(context);
  const created = await findEquipment(context.env.DB, organizationId, id);
  if (!created) return equipmentNotFound(context);
  return context.json({ equipment: toEquipment(created) }, 201);
});

equipment.get("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const item = await findEquipment(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!item) return equipmentNotFound(context);
  const [emails, members] = await Promise.all([
    listLinkedEmails(context.env.DB, organizationId, "equipment", item.id),
    listMemberDirectory(context.env.DB, organizationId),
  ]);
  return context.json({
    canManage: canManage(context),
    emails: emails.map(toLinkedEmail),
    equipment: toEquipment(item),
    members,
    types: equipmentTypes,
  });
});

// Updates the fields present in the body; `assigneeId: null` unassigns.
equipment.patch("/:id", async (context) => {
  if (!canManage(context)) return managerRequired(context);
  const organizationId = context.get("organizationId");
  const existing = await findEquipment(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!existing) return equipmentNotFound(context);
  const input = equipmentInput(
    await context.req.json().catch(() => null),
    existing,
  );
  if (!input) return invalidEquipment(context);
  const result = await context.env.DB.prepare(
    `UPDATE equipment
     SET type = ?, make = ?, model = ?, serial_number = ?, purchase_date = ?,
         assigned_user_id = ?, updated_at = ?
     WHERE id = ? AND organization_id = ? AND ${assigneeIsMember}`,
  )
    .bind(
      input.type,
      input.make,
      input.model,
      input.serialNumber,
      input.purchaseDate,
      input.assigneeId,
      new Date().toISOString(),
      existing.id,
      organizationId,
      input.assigneeId,
      organizationId,
      input.assigneeId,
    )
    .run();
  const updated = await findEquipment(
    context.env.DB,
    organizationId,
    existing.id,
  );
  if (!updated) return equipmentNotFound(context);
  if (result.meta.changes !== 1) return assigneeNotMember(context);
  return context.json({ equipment: toEquipment(updated) });
});

equipment.delete("/:id", async (context) => {
  if (!canManage(context)) return managerRequired(context);
  const organizationId = context.get("organizationId");
  const item = await findEquipment(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!item) return equipmentNotFound(context);
  // Drop email links explicitly rather than relying on the trigger alone.
  await context.env.DB.batch([
    context.env.DB.prepare(
      `DELETE FROM inbound_email_links
       WHERE organization_id = ? AND target_type = 'equipment'
         AND target_id = ?`,
    ).bind(organizationId, item.id),
    context.env.DB.prepare(
      `DELETE FROM equipment WHERE id = ? AND organization_id = ?`,
    ).bind(item.id, organizationId),
  ]);
  return context.body(null, 204);
});

function findEquipment(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `${equipmentSelect} WHERE item.id = ? AND item.organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<EquipmentRow>();
}

/**
 * Validates a new item, or with `existing`, a partial update in which absent
 * fields keep their current values.
 */
function equipmentInput(
  body: unknown,
  existing?: EquipmentRow,
): EquipmentInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const field = (name: string) => Reflect.get(body, name);
  const type = field("type") ?? existing?.type;
  const make = requiredText(field("make") ?? existing?.make, 80);
  const model = requiredText(field("model") ?? existing?.model, 120);
  const serialNumber = optionalText(
    field("serialNumber"),
    existing?.serial_number,
    (value) => (value.length <= 100 ? value : null),
  );
  const purchaseDate = optionalText(
    field("purchaseDate"),
    existing?.purchase_date,
    normalizeBusinessDate,
  );
  const assigneeId = optionalText(
    field("assigneeId"),
    existing?.assigned_user_id,
    (value) => (value.length <= 200 ? value : null),
  );
  if (
    !isEquipmentType(type) ||
    !make ||
    !model ||
    serialNumber === undefined ||
    purchaseDate === undefined ||
    assigneeId === undefined
  ) {
    return null;
  }
  return { assigneeId, make, model, purchaseDate, serialNumber, type };
}

function requiredText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

/**
 * An optional text field: absent keeps `current`, null or blank clears it.
 * Returns undefined when the value is invalid.
 */
function optionalText(
  value: unknown,
  current: string | null | undefined,
  normalize: (value: string) => string | null,
) {
  if (value === undefined) return current ?? null;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return normalize(trimmed) ?? undefined;
}

function isEquipmentType(value: unknown): value is EquipmentType {
  return equipmentTypes.some((type) => type === value);
}

function toEquipment(row: EquipmentRow) {
  return {
    assignee: row.assigned_user_id
      ? {
          email: row.assignee_email ?? "",
          id: row.assigned_user_id,
          name: row.assignee_name ?? "",
        }
      : null,
    createdAt: row.created_at,
    emailCount: row.email_count,
    id: row.id,
    make: row.make,
    model: row.model,
    purchaseDate: row.purchase_date,
    serialNumber: row.serial_number,
    type: row.type,
    updatedAt: row.updated_at,
  };
}

function canManage(context: EquipmentContext) {
  return canManageOrganization(context.get("organizationRole"));
}

function managerRequired(context: EquipmentContext) {
  return context.json(
    { error: "Organization manager access is required." },
    403,
  );
}

function invalidEquipment(context: EquipmentContext) {
  return context.json(
    {
      error:
        "Equipment details are invalid. Choose a type and enter a make, model, and, optionally, a serial number and valid purchase date.",
    },
    400,
  );
}

function assigneeNotMember(context: EquipmentContext) {
  return context.json(
    { error: "Equipment can only be assigned to organization members." },
    400,
  );
}

function equipmentNotFound(context: EquipmentContext) {
  return context.json({ error: "Equipment not found." }, 404);
}

export { equipment };
