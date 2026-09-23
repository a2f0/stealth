import { type Context, Hono } from "hono";
import { sendDeclined } from "./contractMail";
import {
  advanceContract,
  type ContractRow,
  decodePngDataUrl,
  eventStatement,
  type FieldRow,
  findContractById,
  listFields,
  mailFor,
  type RecipientRow,
  recordEvent,
} from "./contractRecords";
import { isSigningToken, signingTokenHash } from "./contractTokens";
import type { Bindings } from "./types";

/** Public routes a signer reaches through their emailed link; no account. */
type SigningEnv = { Bindings: Bindings };
type SigningContext = Context<SigningEnv>;

/** Adopted signatures are small PNGs; this bounds what a signer can store. */
const maxSignatureDataUrlLength = 400_000;
const maxTextValueLength = 500;

const signing = new Hono<SigningEnv>();

signing.get("/:token", async (context) => {
  const signer = await findSigner(context, context.req.param("token"));
  if (!signer) return linkNotFound(context);
  const { contract, recipient } = signer;
  const canSign = signable(contract, recipient);
  if (canSign && recipient.status === "sent") {
    const viewed = await context.env.DB.prepare(
      `UPDATE contract_recipients SET status = 'viewed', viewed_at = ?
       WHERE id = ? AND status = 'sent'`,
    )
      .bind(new Date().toISOString(), recipient.id)
      .run();
    if (viewed.meta.changes === 1) {
      await recordEvent(context.env.DB, {
        contractId: contract.id,
        ip: clientIp(context),
        recipientId: recipient.id,
        type: "viewed",
        userAgent: context.req.header("user-agent") ?? null,
      });
    }
  }
  const [fields, mail] = await Promise.all([
    listFields(context.env.DB, contract.id),
    mailFor(context.env.DB, contract),
  ]);
  return context.json({
    canSign,
    contract: {
      completedAt: contract.completed_at,
      documentFilename: contract.document_filename,
      dueDate: contract.due_date,
      message: contract.message,
      organizationName: mail.organizationName,
      pageCount: contract.document_page_count,
      senderName: mail.sender?.name ?? null,
      status: contract.status,
      title: contract.title,
    },
    fields: fields
      .filter(({ recipient_id }) => recipient_id === recipient.id)
      .map((field) => ({
        height: field.height,
        id: field.id,
        label: field.label,
        page: field.page,
        required: Boolean(field.required),
        type: field.type,
        width: field.width,
        x: field.x,
        y: field.y,
      })),
    recipient: {
      email: recipient.email,
      name: recipient.name,
      signedAt: recipient.signed_at,
      status: recipient.status,
    },
  });
});

signing.get("/:token/document", async (context) => {
  const signer = await findSigner(context, context.req.param("token"));
  if (!signer) return linkNotFound(context);
  if (signer.contract.status === "voided") return voided(context);
  return pdfResponse(
    context,
    signer.contract.document_object_key,
    signer.contract.document_filename,
  );
});

signing.get("/:token/final", async (context) => {
  const signer = await findSigner(context, context.req.param("token"));
  if (!signer?.contract.final_object_key) return linkNotFound(context);
  return pdfResponse(
    context,
    signer.contract.final_object_key,
    signer.contract.document_filename.replace(/\.pdf$/i, " (signed).pdf"),
  );
});

signing.post("/:token/sign", async (context) => {
  const signer = await findSigner(context, context.req.param("token"));
  if (!signer) return linkNotFound(context);
  const { contract, recipient } = signer;
  if (!signable(contract, recipient))
    return cannotSign(context, contract, recipient);
  const fields = (await listFields(context.env.DB, contract.id)).filter(
    ({ recipient_id }) => recipient_id === recipient.id,
  );
  const submission = submissionInput(
    await context.req.json().catch(() => null),
    fields,
  );
  if (typeof submission === "string") {
    return context.json({ error: submission }, 400);
  }
  const { initials, signature, textValues } = submission;
  const database = context.env.DB;
  const now = new Date().toISOString();
  const ip = clientIp(context);
  const userAgent = context.req.header("user-agent")?.slice(0, 300) ?? null;
  // Claims the signature only while the contract is still out for signing,
  // so a double submit or a concurrent void cannot sign twice.
  const signed = await database
    .prepare(
      `UPDATE contract_recipients
       SET status = 'signed', signed_at = ?, signed_ip = ?,
           signed_user_agent = ?, signature_image = ?, initials_image = ?
       WHERE id = ? AND status IN ('sent', 'viewed')
         AND EXISTS (
           SELECT 1 FROM contracts WHERE id = ? AND status = 'sent'
         )`,
    )
    .bind(now, ip, userAgent, signature, initials, recipient.id, contract.id)
    .run();
  if (signed.meta.changes !== 1) {
    return cannotSign(context, contract, recipient);
  }
  await database.batch([
    ...[...textValues].map(([fieldId, value]) =>
      database
        .prepare(
          `UPDATE contract_fields SET value = ?
           WHERE id = ? AND recipient_id = ?`,
        )
        .bind(value || null, fieldId, recipient.id),
    ),
    eventStatement(database, {
      contractId: contract.id,
      ip,
      recipientId: recipient.id,
      type: "signed",
      userAgent,
    }),
  ]);
  const completed = await advanceContract(context.env, contract.id);
  return context.json({ completed, status: "signed" });
});

signing.post("/:token/decline", async (context) => {
  const signer = await findSigner(context, context.req.param("token"));
  if (!signer) return linkNotFound(context);
  const { contract, recipient } = signer;
  if (!signable(contract, recipient))
    return cannotSign(context, contract, recipient);
  const body: unknown = await context.req.json().catch(() => null);
  const raw =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "reason")
      : "";
  const reason = typeof raw === "string" ? raw.trim().slice(0, 500) : "";
  const database = context.env.DB;
  const now = new Date().toISOString();
  const declined = await database
    .prepare(
      `UPDATE contract_recipients
       SET status = 'declined', declined_at = ?, decline_reason = ?
       WHERE id = ? AND status IN ('sent', 'viewed')
         AND EXISTS (
           SELECT 1 FROM contracts WHERE id = ? AND status = 'sent'
         )`,
    )
    .bind(now, reason || null, recipient.id, contract.id)
    .run();
  if (declined.meta.changes !== 1)
    return cannotSign(context, contract, recipient);
  await database.batch([
    database
      .prepare(
        `UPDATE contracts SET status = 'declined', updated_at = ?
         WHERE id = ? AND status = 'sent'`,
      )
      .bind(now, contract.id),
    eventStatement(database, {
      contractId: contract.id,
      detail: reason || null,
      ip: clientIp(context),
      recipientId: recipient.id,
      type: "declined",
      userAgent: context.req.header("user-agent") ?? null,
    }),
  ]);
  try {
    await sendDeclined(
      context.env,
      await mailFor(database, contract),
      recipient,
      reason,
    );
  } catch (cause) {
    console.error("Decline notice could not be sent.", cause);
  }
  return context.json({ status: "declined" });
});

/**
 * Validates what a signer submits: consent, the images their fields need,
 * and their text fields. Returns a message when something is missing.
 */
function submissionInput(body: unknown, fields: FieldRow[]) {
  if (typeof body !== "object" || body === null) {
    return "The signature is invalid.";
  }
  const get = (name: string) => Reflect.get(body, name);
  if (get("consent") !== true) {
    return "Agree to use electronic records and signatures to sign.";
  }
  const signature = adoptedImage(get("signature"));
  const initials = adoptedImage(get("initials"));
  if (fields.some(({ type }) => type === "signature") && !signature) {
    return "Adopt a signature to sign.";
  }
  if (fields.some(({ type }) => type === "initials") && !initials) {
    return "Adopt your initials to sign.";
  }
  const values = get("values");
  const textValues = new Map<string, string>();
  for (const field of fields.filter(({ type }) => type === "text")) {
    const raw =
      typeof values === "object" && values !== null
        ? Reflect.get(values, field.id)
        : undefined;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value.length > maxTextValueLength) return "A field's text is too long.";
    if (field.required && !value) return "Fill in every required field.";
    textValues.set(field.id, value);
  }
  return { initials, signature, textValues };
}

async function findSigner(context: SigningContext, token: string) {
  if (!isSigningToken(token)) return null;
  const recipient = await context.env.DB.prepare(
    `SELECT id, contract_id, name, email, routing_order, status, token_nonce,
            notified_at, last_reminded_at, viewed_at, signed_at, signed_ip,
            signed_user_agent, signature_image, initials_image, declined_at,
            decline_reason, created_at
     FROM contract_recipients WHERE token_hash = ?`,
  )
    .bind(await signingTokenHash(token))
    .first<RecipientRow>();
  if (!recipient) return null;
  const contract = await findContractById(
    context.env.DB,
    recipient.contract_id,
  );
  return contract ? { contract, recipient } : null;
}

function signable(contract: ContractRow, recipient: RecipientRow) {
  return (
    contract.status === "sent" &&
    (recipient.status === "sent" || recipient.status === "viewed")
  );
}

function cannotSign(
  context: SigningContext,
  contract: ContractRow,
  recipient: RecipientRow,
) {
  let error = "This contract can no longer be signed.";
  if (recipient.status === "signed")
    error = "You have already signed this contract.";
  else if (recipient.status === "declined")
    error = "You declined this contract.";
  else if (contract.status === "voided")
    error = "The sender voided this contract.";
  return context.json({ error }, 409);
}

/** A PNG data URL within the size limit, or null. */
function adoptedImage(value: unknown) {
  if (typeof value !== "string" || value.length > maxSignatureDataUrlLength) {
    return null;
  }
  return decodePngDataUrl(value) ? value : null;
}

function clientIp(context: SigningContext) {
  return context.req.header("cf-connecting-ip") ?? null;
}

async function pdfResponse(
  context: SigningContext,
  key: string,
  filename: string,
) {
  const object = await context.env.STORAGE.get(key);
  if (!object)
    return context.json({ error: "The document file is missing." }, 404);
  const encoded = encodeURIComponent(filename).replaceAll("'", "%27");
  return new Response(object.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="contract.pdf"; filename*=UTF-8''${encoded}`,
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
    },
  });
}

function linkNotFound(context: SigningContext) {
  return context.json({ error: "This signing link is invalid." }, 404);
}

function voided(context: SigningContext) {
  return context.json({ error: "The sender voided this contract." }, 410);
}

export { signing };
