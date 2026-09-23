import { type Context, Hono } from "hono";
import { sendDeclined } from "./contractMail";
import { isEmbeddablePng } from "./contractPdf";
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
import {
  isSigningToken,
  signingToken,
  signingTokenHash,
} from "./contractTokens";
import type { Bindings } from "./types";

/** Public routes a signer reaches through their emailed link; no account. */
type SigningEnv = { Bindings: Bindings };
type SigningContext = Context<SigningEnv>;

/** Adopted signatures are small PNGs; this bounds what a signer can store. */
const maxSignatureDataUrlLength = 400_000;
const maxTextValueLength = 500;

// A signature or decline only lands while the signer still has their turn
// and the contract is out for signing; bound as [recipientId, contractId].
const stillSignable = `EXISTS (
    SELECT 1 FROM contract_recipients
    WHERE id = ? AND status IN ('sent', 'viewed')
  ) AND EXISTS (SELECT 1 FROM contracts WHERE id = ? AND status = 'sent')`;

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
  for (const image of [signature, initials]) {
    const bytes = image ? decodePngDataUrl(image) : null;
    if (image && !(bytes && (await isEmbeddablePng(bytes)))) {
      return context.json(
        { error: "The adopted signature could not be read." },
        400,
      );
    }
  }
  const database = context.env.DB;
  const now = new Date().toISOString();
  const ip = clientIp(context);
  const userAgent = context.req.header("user-agent")?.slice(0, 300) ?? null;
  const guard = [recipient.id, contract.id];
  // One transaction: the values and event are written first, under the same
  // condition as the claim, so they land exactly when the signature does and
  // before anyone can see the signer as signed.
  const results = await database.batch([
    ...[...textValues].map(([fieldId, value]) =>
      database
        .prepare(
          `UPDATE contract_fields SET value = ?
           WHERE id = ? AND recipient_id = ? AND ${stillSignable}`,
        )
        .bind(value || null, fieldId, recipient.id, ...guard),
    ),
    eventStatement(
      database,
      {
        contractId: contract.id,
        ip,
        recipientId: recipient.id,
        type: "signed",
        userAgent,
      },
      { bindings: guard, sql: stillSignable },
    ),
    database
      .prepare(
        `UPDATE contract_recipients
         SET status = 'signed', signed_at = ?, signed_ip = ?,
             signed_user_agent = ?, signature_image = ?, initials_image = ?
         WHERE id = ? AND ${stillSignable}`,
      )
      .bind(now, ip, userAgent, signature, initials, recipient.id, ...guard),
  ]);
  if (results.at(-1)?.meta.changes !== 1) {
    return cannotSign(context, contract, recipient);
  }
  // The signature is recorded; routing and completion are retried by the
  // scheduled sweep if they fail here.
  let completed = false;
  try {
    completed = await advanceContract(context.env, contract.id);
  } catch (cause) {
    console.error("Contract could not advance after a signature.", cause);
  }
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
  const guard = [recipient.id, contract.id];
  // One transaction, as with signing: the event, the decline, and the
  // contract's end all land together or not at all.
  const results = await database.batch([
    eventStatement(
      database,
      {
        contractId: contract.id,
        detail: reason || null,
        ip: clientIp(context),
        recipientId: recipient.id,
        type: "declined",
        userAgent: context.req.header("user-agent") ?? null,
      },
      { bindings: guard, sql: stillSignable },
    ),
    database
      .prepare(
        `UPDATE contract_recipients
         SET status = 'declined', declined_at = ?, decline_reason = ?
         WHERE id = ? AND ${stillSignable}`,
      )
      .bind(now, reason || null, recipient.id, ...guard),
    database
      .prepare(
        `UPDATE contracts SET status = 'declined', updated_at = ?
         WHERE id = ? AND status = 'sent'
           AND EXISTS (
             SELECT 1 FROM contract_recipients
             WHERE contract_id = contracts.id AND status = 'declined'
           )`,
      )
      .bind(now, contract.id),
  ]);
  if (results[1]?.meta.changes !== 1) {
    return cannotSign(context, contract, recipient);
  }
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

/**
 * The recipient a link belongs to. The link must still derive from the
 * current BETTER_AUTH_SECRET, and its organization must not be deleted.
 */
async function findSigner(context: SigningContext, token: string) {
  if (!isSigningToken(token)) return null;
  const recipient = await context.env.DB.prepare(
    `SELECT recipient.id, recipient.contract_id, recipient.name,
            recipient.email, recipient.routing_order, recipient.status,
            recipient.token_nonce, recipient.token_hash, recipient.notified_at,
            recipient.last_reminded_at, recipient.viewed_at,
            recipient.signed_at, recipient.signed_ip,
            recipient.signed_user_agent, recipient.signature_image,
            recipient.initials_image, recipient.declined_at,
            recipient.decline_reason, recipient.created_at
     FROM contract_recipients AS recipient
     JOIN contracts AS contract ON contract.id = recipient.contract_id
     JOIN organization ON organization.id = contract.organization_id
     WHERE recipient.token_hash = ? AND organization.deletedAt IS NULL`,
  )
    .bind(await signingTokenHash(token))
    .first<RecipientRow>();
  if (!recipient?.token_nonce) return null;
  // Compared as hashes so timing reveals nothing about the expected token.
  const expected = await signingToken(
    context.env.BETTER_AUTH_SECRET,
    recipient.id,
    recipient.token_nonce,
  );
  if ((await signingTokenHash(expected)) !== recipient.token_hash) return null;
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
