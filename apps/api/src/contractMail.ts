import type { Bindings } from "./types";

type MailEnvironment = Pick<
  Bindings,
  "AUTH_EMAIL_FROM" | "CORS_ORIGIN" | "EMAIL"
>;

export interface ContractMail {
  contractId: string;
  dueDate: string | null;
  message: string;
  organizationName: string;
  sender: { email: string; name: string } | null;
  title: string;
}

interface Person {
  email: string;
  name: string;
}

/** Largest signed PDF attached to completion emails; larger ones are linked. */
const maxAttachmentBytes = 8 * 1024 * 1024;

export function signingUrl(environment: MailEnvironment, token: string) {
  return new URL(`/sign/${token}`, environment.CORS_ORIGIN).toString();
}

export function contractUrl(environment: MailEnvironment, contractId: string) {
  return new URL(
    `/contracts/${encodeURIComponent(contractId)}`,
    environment.CORS_ORIGIN,
  ).toString();
}

/** Asks a signer to review and sign, or reminds them to. */
export function sendSigningRequest(
  environment: MailEnvironment,
  mail: ContractMail,
  recipient: Person,
  url: string,
  reminder: boolean,
) {
  const from = mail.sender?.name ?? mail.organizationName;
  const due = mail.dueDate ? dueSentence(mail.dueDate) : null;
  return send(environment, mail, {
    subject: reminder
      ? `Reminder: please sign “${mail.title}”`
      : `${from} sent you “${mail.title}” to sign`,
    text: [
      `Hi ${recipient.name},`,
      "",
      reminder
        ? `${from} is still waiting for your signature on “${mail.title}”.`
        : `${from} from ${mail.organizationName} sent you “${mail.title}” to review and sign.`,
      ...(mail.message ? ["", mail.message] : []),
      ...(due ? ["", due] : []),
      "",
      "Review and sign:",
      url,
      "",
      "This link is personal to you. Don’t forward this email.",
    ].join("\n"),
    to: recipient,
  });
}

/** Sends a completed contract's signed PDF to one person. */
export function sendCompletion(
  environment: MailEnvironment,
  mail: ContractMail,
  recipient: Person,
  link: string,
  signedPdf: Uint8Array,
  filename: string,
) {
  const attach = signedPdf.byteLength <= maxAttachmentBytes;
  return send(environment, mail, {
    attachments: attach
      ? [
          {
            content: signedPdf,
            disposition: "attachment",
            filename,
            type: "application/pdf",
          },
        ]
      : undefined,
    subject: `Completed: “${mail.title}”`,
    text: [
      `Hi ${recipient.name},`,
      "",
      `Everyone has signed “${mail.title}”.`,
      attach
        ? "The signed document, with its certificate of completion, is attached."
        : "Download the signed document, with its certificate of completion:",
      ...(attach ? ["", "You can also download it here:"] : []),
      link,
    ].join("\n"),
    to: recipient,
  });
}

/** Tells the sender that a signer declined. */
export function sendDeclined(
  environment: MailEnvironment,
  mail: ContractMail,
  signer: Person,
  reason: string,
) {
  if (!mail.sender) return Promise.resolve();
  return send(environment, mail, {
    subject: `Declined: “${mail.title}”`,
    text: [
      `Hi ${mail.sender.name},`,
      "",
      `${signer.name} (${signer.email}) declined to sign “${mail.title}”.`,
      ...(reason ? ["", `Reason: ${reason}`] : []),
      "",
      contractUrl(environment, mail.contractId),
    ].join("\n"),
    to: mail.sender,
  });
}

/** Tells a signer that a contract they were sent was voided. */
export function sendVoided(
  environment: MailEnvironment,
  mail: ContractMail,
  recipient: Person,
  reason: string,
) {
  return send(environment, mail, {
    subject: `Voided: “${mail.title}”`,
    text: [
      `Hi ${recipient.name},`,
      "",
      `${mail.organizationName} voided “${mail.title}”. You no longer need to sign it.`,
      ...(reason ? ["", `Reason: ${reason}`] : []),
    ].join("\n"),
    to: recipient,
  });
}

function send(
  environment: MailEnvironment,
  mail: ContractMail,
  message: {
    attachments?: EmailAttachment[] | undefined;
    subject: string;
    text: string;
    to: Person;
  },
) {
  return environment.EMAIL.send({
    ...(message.attachments ? { attachments: message.attachments } : {}),
    from: {
      email: environment.AUTH_EMAIL_FROM,
      name: `${mail.organizationName} via Tearleads`.slice(0, 100),
    },
    ...(mail.sender ? { replyTo: mail.sender.email } : {}),
    subject: message.subject.slice(0, 250),
    text: message.text,
    to: { email: message.to.email, name: message.to.name },
  });
}

function dueSentence(dueDate: string) {
  const due = new Date(`${dueDate}T12:00:00Z`);
  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(due);
  return new Date().toISOString().slice(0, 10) > dueDate
    ? `This was due on ${formatted}.`
    : `Please sign by ${formatted}.`;
}
