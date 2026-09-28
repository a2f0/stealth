import { and, count, desc, eq, exists, isNull, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { normalizeBusinessDate } from "./businesses";
import { type Db, getDb } from "./db";
import { listLinkedEmails, toLinkedEmail } from "./inboundEmailLinks";
import {
  canManageOrganization,
  listMemberDirectory,
} from "./organizationMembers";
import {
  equipment as equipmentTable,
  inboundEmailLinks,
  inboundEmails,
  member,
  user,
} from "./schema";
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

function selectEquipment(db: Db) {
  return db
    .select({
      id: equipmentTable.id,
      type: equipmentTable.type,
      make: equipmentTable.make,
      model: equipmentTable.model,
      serial_number: equipmentTable.serialNumber,
      purchase_date: equipmentTable.purchaseDate,
      assigned_user_id: equipmentTable.assignedUserId,
      created_at: equipmentTable.createdAt,
      updated_at: equipmentTable.updatedAt,
      assignee_name: user.name,
      assignee_email: user.email,
      email_count: sql<number>`${db
        .select({ count: count() })
        .from(inboundEmailLinks)
        .innerJoin(
          inboundEmails,
          eq(inboundEmails.id, inboundEmailLinks.emailId),
        )
        .where(
          and(
            eq(inboundEmailLinks.organizationId, equipmentTable.organizationId),
            eq(inboundEmailLinks.targetType, "equipment"),
            eq(inboundEmailLinks.targetId, equipmentTable.id),
            isNull(inboundEmails.deletedAt),
          ),
        )}`,
    })
    .from(equipmentTable)
    .leftJoin(user, eq(user.id, equipmentTable.assignedUserId));
}

// The assignee must be a current member of the organization, checked in the
// same statement as the write so a concurrent removal cannot slip past it.
function assigneeIsMember(
  db: Db,
  organizationId: string,
  assigneeId: string | null,
) {
  return or(
    sql`${assigneeId} IS NULL`,
    exists(
      db
        .select({ one: sql`1` })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            sql`${member.userId} = ${assigneeId}`,
          ),
        ),
    ),
  );
}

const equipment = new Hono<EquipmentEnv>();

equipment.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const [items, members] = await Promise.all([
    selectEquipment(getDb(context.env.DB))
      .where(eq(equipmentTable.organizationId, organizationId))
      .orderBy(desc(equipmentTable.createdAt), desc(equipmentTable.id)),
    listMemberDirectory(context.env.DB, organizationId),
  ]);
  return context.json({
    canManage: canManage(context),
    equipment: items.map(toEquipment),
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
  const db = getDb(context.env.DB);
  // Drizzle lists every equipment column in schema order, which the selected
  // values follow.
  const result = await db
    .insert(equipmentTable)
    .select(
      sql`SELECT ${id}, ${organizationId}, ${input.type}, ${input.make},
                 ${input.model}, ${input.serialNumber}, ${input.purchaseDate},
                 ${input.assigneeId}, ${context.get("authSession").user.id},
                 ${now}, ${now}
          WHERE ${assigneeIsMember(db, organizationId, input.assigneeId)}`,
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

// Updates only the fields present in the body, so concurrent edits to other
// fields are kept; `assigneeId: null` unassigns.
equipment.patch("/:id", async (context) => {
  if (!canManage(context)) return managerRequired(context);
  const organizationId = context.get("organizationId");
  const existing = await findEquipment(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!existing) return equipmentNotFound(context);
  const changes = equipmentChanges(
    await context.req.json().catch(() => null),
    existing.type,
  );
  if (!changes) return invalidEquipment(context);
  const assigneeChanges = "assignedUserId" in changes;
  const assigneeId = changes.assignedUserId ?? null;
  const db = getDb(context.env.DB);
  const result = await db
    .update(equipmentTable)
    .set({ ...changes, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(equipmentTable.id, existing.id),
        eq(equipmentTable.organizationId, organizationId),
        assigneeChanges
          ? assigneeIsMember(db, organizationId, assigneeId)
          : undefined,
      ),
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
  const db = getDb(context.env.DB);
  await db.batch([
    db
      .delete(inboundEmailLinks)
      .where(
        and(
          eq(inboundEmailLinks.organizationId, organizationId),
          eq(inboundEmailLinks.targetType, "equipment"),
          eq(inboundEmailLinks.targetId, item.id),
        ),
      ),
    db
      .delete(equipmentTable)
      .where(
        and(
          eq(equipmentTable.id, item.id),
          eq(equipmentTable.organizationId, organizationId),
        ),
      ),
  ]);
  return context.body(null, 204);
});

function findEquipment(
  database: D1Database,
  organizationId: string,
  id: string,
): Promise<EquipmentRow | undefined> {
  return selectEquipment(getDb(database))
    .where(
      and(
        eq(equipmentTable.id, id),
        eq(equipmentTable.organizationId, organizationId),
      ),
    )
    .get();
}

/** Validates a new item; optional fields may be omitted. */
function equipmentInput(body: unknown): EquipmentInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const field = (name: string) => Reflect.get(body, name);
  const type = field("type");
  const make = requiredText(field("make"), 80);
  const model = requiredText(field("model"), 120);
  const serialNumber = optionalText(field("serialNumber"), normalizeSerial);
  const purchaseDate = optionalText(
    field("purchaseDate"),
    normalizeBusinessDate,
  );
  const assigneeId = optionalText(field("assigneeId"), normalizeUserId);
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

type EquipmentColumn =
  | "assignedUserId"
  | "make"
  | "model"
  | "purchaseDate"
  | "serialNumber"
  | "type";
type EquipmentChanges = Partial<
  Pick<typeof equipmentTable.$inferInsert, EquipmentColumn>
>;

/**
 * Validates the fields present in an update, as column changes. An item keeps
 * its current type even after that type stops being offered.
 */
function equipmentChanges(
  body: unknown,
  currentType: string,
): EquipmentChanges | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const changes: Partial<Record<EquipmentColumn, string | null>> = {};
  const fields: Array<[string, EquipmentColumn, (value: unknown) => unknown]> =
    [
      [
        "type",
        "type",
        (value) =>
          isEquipmentType(value) || value === currentType ? value : undefined,
      ],
      ["make", "make", (value) => requiredText(value, 80) ?? undefined],
      ["model", "model", (value) => requiredText(value, 120) ?? undefined],
      [
        "serialNumber",
        "serialNumber",
        (value) => optionalText(value, normalizeSerial),
      ],
      [
        "purchaseDate",
        "purchaseDate",
        (value) => optionalText(value, normalizeBusinessDate),
      ],
      [
        "assigneeId",
        "assignedUserId",
        (value) => optionalText(value, normalizeUserId),
      ],
    ];
  for (const [name, column, validate] of fields) {
    const value = Reflect.get(body, name);
    if (value === undefined) continue;
    const valid = validate(value);
    if (valid === undefined) return null;
    changes[column] = valid as string | null;
  }
  // The validators keep the required columns non-null.
  return changes as EquipmentChanges;
}

function requiredText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

/**
 * An optional text field: absent, null, or blank is null. Returns undefined
 * when the value is invalid.
 */
function optionalText(
  value: unknown,
  normalize: (value: string) => string | null,
) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return normalize(trimmed) ?? undefined;
}

function normalizeSerial(value: string) {
  return value.length <= 100 ? value : null;
}

function normalizeUserId(value: string) {
  return value.length <= 200 ? value : null;
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
