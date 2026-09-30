import { and, asc, desc, eq, exists, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { type Db, getDb } from "./db";
import { userHasCapability } from "./organizationGroups";
import {
  equipment,
  inboundEmailAttachments,
  inboundEmailLinks,
  inboundEmails,
  libraryFolders,
  plaidTransactions,
} from "./schema";
import type { Bindings } from "./types";

type LinkContext<Path extends string = string> = Context<
  {
    Bindings: Bindings;
    Variables: AuthVariables;
  },
  Path
>;

type EmailLinkTargetType =
  | "equipment"
  | "finance_transaction"
  | "library_folder";

interface EmailLinkInput {
  targetId: string;
  targetType: EmailLinkTargetType;
}

interface EmailLinkRow {
  equipment_make: string | null;
  equipment_model: string | null;
  equipment_serial_number: string | null;
  equipment_type: string | null;
  folder_name: string | null;
  id: string;
  target_id: string;
  target_type: string;
  transaction_amount: number | null;
  transaction_currency_code: string | null;
  transaction_date: string | null;
  transaction_merchant_name: string | null;
  transaction_name: string | null;
}

interface LinkedEmailRow {
  attachment_count: number;
  envelope_from: string;
  id: string;
  link_id: string;
  received_at: string;
  subject: string | null;
  target_id: string;
}

/**
 * The records an email is linked to. Finance links are only visible to
 * members of a group with the Finance capability, and, like the Finance
 * listing, hide transactions that Plaid has since removed.
 */
export async function listEmailLinks(
  context: LinkContext,
  organizationId: string,
  emailId: string,
) {
  const rows = await emailLinkRows(context.env.DB, organizationId, emailId);
  const financeVisible =
    rows.some(({ target_type }) => target_type === "finance_transaction") &&
    (await canUseFinance(context));
  return rows
    .filter(
      (row) => financeVisible || row.target_type !== "finance_transaction",
    )
    .flatMap((row) => toEmailLink(row) ?? []);
}

/** Links an inbox email to a library folder, equipment, or a transaction. */
export async function createEmailLink(context: LinkContext) {
  const emailId = context.req.param("id");
  const input = linkInput(await context.req.json().catch(() => null));
  if (!emailId || !input) {
    return context.json(
      { error: "A link target type and id are required." },
      400,
    );
  }
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const db = getDb(database);
  const email = await db
    .select({ id: inboundEmails.id })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.id, emailId),
        eq(inboundEmails.organizationId, organizationId),
        isNull(inboundEmails.deletedAt),
      ),
    )
    .get();
  if (!email) return context.json({ error: "Email not found." }, 404);
  if (
    input.targetType === "finance_transaction" &&
    !(await canUseFinance(context))
  ) {
    return financeRequired(context);
  }
  // The target is checked in the insert itself: a target deleted a moment
  // earlier (after its cleanup trigger ran) must not gain an orphaned link.
  const id = crypto.randomUUID();
  const createdBy = context.get("authSession").user.id;
  const createdAt = new Date().toISOString();
  const targetFound = targetExists(
    db,
    input.targetType,
    input.targetId,
    organizationId,
  );
  await db
    .insert(inboundEmailLinks)
    .select(
      sql`select ${id}, ${organizationId}, ${email.id}, ${input.targetType},
                 ${input.targetId}, ${createdBy}, ${createdAt}
          where ${targetFound}`,
    )
    .onConflictDoNothing({
      target: [
        inboundEmailLinks.emailId,
        inboundEmailLinks.targetType,
        inboundEmailLinks.targetId,
      ],
    });
  const row = (await emailLinkRows(database, organizationId, email.id)).find(
    (link) =>
      link.target_type === input.targetType &&
      link.target_id === input.targetId,
  );
  const link = row && toEmailLink(row);
  if (!link) return context.json({ error: "Link target not found." }, 404);
  return context.json({ link }, link.id === id ? 201 : 200);
}

export async function deleteEmailLink(
  context: LinkContext<"/:id/links/:linkId">,
) {
  const organizationId = context.get("organizationId");
  const db = getDb(context.env.DB);
  const link = await db
    .select({
      id: inboundEmailLinks.id,
      target_type: inboundEmailLinks.targetType,
    })
    .from(inboundEmailLinks)
    .where(
      and(
        eq(inboundEmailLinks.id, context.req.param("linkId")),
        eq(inboundEmailLinks.emailId, context.req.param("id")),
        eq(inboundEmailLinks.organizationId, organizationId),
      ),
    )
    .get();
  if (!link) return context.json({ error: "Link not found." }, 404);
  if (
    link.target_type === "finance_transaction" &&
    !(await canUseFinance(context))
  ) {
    return financeRequired(context);
  }
  await db
    .delete(inboundEmailLinks)
    .where(
      and(
        eq(inboundEmailLinks.id, link.id),
        eq(inboundEmailLinks.organizationId, organizationId),
      ),
    );
  return context.body(null, 204);
}

/**
 * Emails outside Trash that are linked to records of one type, newest first.
 * Pass a target id to limit the result to a single record.
 */
export async function listLinkedEmails(
  database: D1Database,
  organizationId: string,
  targetType: EmailLinkTargetType,
  targetId?: string,
) {
  const db = getDb(database);
  const rows: LinkedEmailRow[] = await db
    .select({
      link_id: inboundEmailLinks.id,
      target_id: inboundEmailLinks.targetId,
      id: inboundEmails.id,
      subject: inboundEmails.subject,
      envelope_from: inboundEmails.envelopeFrom,
      received_at: inboundEmails.receivedAt,
      attachment_count: db.$count(
        inboundEmailAttachments,
        eq(inboundEmailAttachments.emailId, inboundEmails.id),
      ),
    })
    .from(inboundEmailLinks)
    .innerJoin(
      inboundEmails,
      and(
        eq(inboundEmails.id, inboundEmailLinks.emailId),
        eq(inboundEmails.organizationId, inboundEmailLinks.organizationId),
      ),
    )
    .where(
      and(
        eq(inboundEmailLinks.organizationId, organizationId),
        eq(inboundEmailLinks.targetType, targetType),
        targetId ? eq(inboundEmailLinks.targetId, targetId) : undefined,
        isNull(inboundEmails.deletedAt),
      ),
    )
    .orderBy(desc(inboundEmails.receivedAt), desc(inboundEmails.id));
  return rows;
}

export function toLinkedEmail(row: LinkedEmailRow) {
  return {
    attachmentCount: row.attachment_count,
    from: row.envelope_from,
    id: row.id,
    linkId: row.link_id,
    receivedAt: row.received_at,
    subject: row.subject,
  };
}

async function emailLinkRows(
  database: D1Database,
  organizationId: string,
  emailId: string,
) {
  const rows: EmailLinkRow[] = await getDb(database)
    .select({
      id: inboundEmailLinks.id,
      target_type: inboundEmailLinks.targetType,
      target_id: inboundEmailLinks.targetId,
      folder_name: libraryFolders.name,
      equipment_type: equipment.type,
      equipment_make: equipment.make,
      equipment_model: equipment.model,
      equipment_serial_number: equipment.serialNumber,
      transaction_name: plaidTransactions.name,
      transaction_merchant_name: plaidTransactions.merchantName,
      transaction_amount: plaidTransactions.amount,
      transaction_currency_code: plaidTransactions.currencyCode,
      transaction_date: plaidTransactions.transactionDate,
    })
    .from(inboundEmailLinks)
    .leftJoin(
      libraryFolders,
      and(
        eq(inboundEmailLinks.targetType, "library_folder"),
        eq(libraryFolders.id, inboundEmailLinks.targetId),
        eq(libraryFolders.organizationId, inboundEmailLinks.organizationId),
      ),
    )
    .leftJoin(
      equipment,
      and(
        eq(inboundEmailLinks.targetType, "equipment"),
        eq(equipment.id, inboundEmailLinks.targetId),
        eq(equipment.organizationId, inboundEmailLinks.organizationId),
      ),
    )
    .leftJoin(
      plaidTransactions,
      and(
        eq(inboundEmailLinks.targetType, "finance_transaction"),
        eq(plaidTransactions.id, inboundEmailLinks.targetId),
        eq(plaidTransactions.organizationId, inboundEmailLinks.organizationId),
        eq(plaidTransactions.sourceStatus, "active"),
      ),
    )
    .where(
      and(
        eq(inboundEmailLinks.emailId, emailId),
        eq(inboundEmailLinks.organizationId, organizationId),
      ),
    )
    .orderBy(
      asc(inboundEmailLinks.createdAt),
      asc(sql`${inboundEmailLinks}.rowid`),
    );
  return rows;
}

/** Whether the link target exists in the organization. */
function targetExists(
  db: Db,
  targetType: EmailLinkTargetType,
  targetId: string,
  organizationId: string,
) {
  if (targetType === "equipment") {
    return exists(
      db
        .select({ one: sql`1` })
        .from(equipment)
        .where(
          and(
            eq(equipment.id, targetId),
            eq(equipment.organizationId, organizationId),
          ),
        ),
    );
  }
  if (targetType === "finance_transaction") {
    return exists(
      db
        .select({ one: sql`1` })
        .from(plaidTransactions)
        .where(
          and(
            eq(plaidTransactions.id, targetId),
            eq(plaidTransactions.organizationId, organizationId),
            eq(plaidTransactions.sourceStatus, "active"),
          ),
        ),
    );
  }
  return exists(
    db
      .select({ one: sql`1` })
      .from(libraryFolders)
      .where(
        and(
          eq(libraryFolders.id, targetId),
          eq(libraryFolders.organizationId, organizationId),
        ),
      ),
  );
}

function canUseFinance(context: LinkContext) {
  return userHasCapability(
    context.env.DB,
    context.get("organizationId"),
    context.get("authSession").user.id,
    "finance",
  );
}

function toEmailLink(row: EmailLinkRow) {
  if (row.target_type === "equipment") {
    if (row.equipment_make === null) return null;
    return {
      equipment: {
        make: row.equipment_make,
        model: row.equipment_model ?? "",
        serialNumber: row.equipment_serial_number,
        type: row.equipment_type ?? "",
      },
      id: row.id,
      targetId: row.target_id,
      targetType: row.target_type,
    };
  }
  if (row.target_type === "library_folder") {
    if (row.folder_name === null) return null;
    return {
      folder: { name: row.folder_name },
      id: row.id,
      targetId: row.target_id,
      targetType: row.target_type,
    };
  }
  if (row.transaction_name === null) return null;
  return {
    id: row.id,
    targetId: row.target_id,
    targetType: row.target_type,
    transaction: {
      amount: row.transaction_amount ?? 0,
      currencyCode: row.transaction_currency_code,
      date: row.transaction_date ?? "",
      merchantName: row.transaction_merchant_name,
      name: row.transaction_name,
    },
  };
}

function linkInput(input: unknown): EmailLinkInput | null {
  if (typeof input !== "object" || input === null) return null;
  const targetType = Reflect.get(input, "targetType");
  const targetId = Reflect.get(input, "targetId");
  if (
    (targetType !== "equipment" &&
      targetType !== "library_folder" &&
      targetType !== "finance_transaction") ||
    typeof targetId !== "string" ||
    targetId.length === 0 ||
    targetId.length > 100
  ) {
    return null;
  }
  return { targetId, targetType };
}

function financeRequired(context: LinkContext) {
  return context.json({ error: "Finance group membership required." }, 403);
}
