import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { draftInput, draftStatements, validEmail } from "./contractDraft";
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
import { contractTemplates } from "./contractTemplates";
import { normalizeFilename } from "./filenames";
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

const contracts = new Hono<ContractEnv>();

contracts.route("/templates", contractTemplates);

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
  const saved = await database.batch(
    draftStatements(database, contract, draft, new Date().toISOString()),
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
  const sent = await database
    .prepare(
      `UPDATE contracts
       SET status = 'sent', sent_at = ?, sent_by = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'draft'
         AND revision = ?`,
    )
    .bind(now, userId, now, contract.id, organizationId, contract.revision)
    .run();
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
    const claim = await database
      .prepare(
        `UPDATE contract_recipients SET last_reminded_at = ?
         WHERE id = ? AND COALESCE(last_reminded_at, notified_at) <= ?`,
      )
      .bind(now.toISOString(), recipient.id, threshold.toISOString())
      .run();
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
  const deleted = await database.batch([
    ...keys.map(([kind, key]) =>
      database
        .prepare(
          `INSERT OR REPLACE INTO deleted_object_cleanup
             (id, organization_id, object_key, deleted_at, cleanup_token,
              cleanup_claimed_at)
           SELECT ?, ?, ?, ?, NULL, NULL FROM contracts
           WHERE id = ? AND organization_id = ? AND status <> 'sent'`,
        )
        .bind(
          `${kind}:${contract.id}`,
          organizationId,
          key,
          now,
          contract.id,
          organizationId,
        ),
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
    template:
      contract.template_name && contract.template_version
        ? { name: contract.template_name, version: contract.template_version }
        : null,
    title: contract.title,
    updatedAt: contract.updated_at,
    voidReason: contract.void_reason,
    voidedAt: contract.voided_at,
  };
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
