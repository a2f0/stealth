import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { handleEmail } from "./email";
import { createTestD1, migratedDatabase } from "./testDatabase";
import type { Bindings } from "./types";

const organizationId = "organization-1";
const inboundEmailDomain = "inbox.tearleads.de";
const recipient = `upload+${organizationId}@${inboundEmailDomain}`;
const rawEmail = [
  "From: Sender <sender@example.com>",
  `To: ${recipient}`,
  "Subject: Test attachment",
  "Message-ID: <test@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="test-boundary"',
  "",
  "--test-boundary",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Hello from the message body.",
  "--test-boundary",
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  "Content-Transfer-Encoding: base64",
  "",
  "aGVsbG8gYXR0YWNobWVudA==",
  "--test-boundary--",
  "",
].join("\r\n");

interface CapturedStatement {
  query: string;
  values: readonly SQLQueryBindings[];
}

describe("inbound email", () => {
  it("stores the raw message, attachments, and metadata", async () => {
    const database = await createDatabase();
    const storage = createStorage();
    const received = createMessage(rawEmail);

    await handleEmail(
      received.message,
      createBindings(database.value, storage.value),
    );

    expect(received.rejection()).toBeUndefined();
    expect(storage.objects.size).toBe(2);
    expect(database.statements).toHaveLength(2);

    const rawEntry = [...storage.objects].find(([key]) =>
      key.endsWith("/message.eml"),
    );
    const attachmentEntry = [...storage.objects].find(([key]) =>
      key.includes("/attachments/"),
    );
    expect(new TextDecoder().decode(rawEntry?.[1])).toBe(rawEmail);
    expect(new TextDecoder().decode(attachmentEntry?.[1])).toBe(
      "hello attachment",
    );
    expect(
      rawEntry?.[0]?.startsWith(
        `organizations/${organizationId}/inbound-emails/`,
      ),
    ).toBe(true);

    const [emailStatement, attachmentStatement] = database.statements;
    expect(emailStatement?.values.slice(1, 6)).toEqual([
      organizationId,
      "<test@example.com>",
      "sender@example.com",
      recipient,
      "Test attachment",
    ]);
    expect(attachmentStatement?.values.slice(3, 6)).toEqual([
      "notes.txt",
      "text/plain",
      16,
    ]);
  });

  it("rejects mail sent to an unknown organization", async () => {
    const database = await createDatabase();
    const storage = createStorage();
    const received = createMessage(
      rawEmail,
      `upload+unknown-organization@${inboundEmailDomain}`,
    );

    await handleEmail(
      received.message,
      createBindings(database.value, storage.value),
    );

    expect(received.rejection()).toBe("Unknown recipient");
    expect(storage.objects.size).toBe(0);
    expect(database.statements).toHaveLength(0);
  });
});

function createBindings(database: D1Database, storage: R2Bucket): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.de",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.tearleads.de",
    CORS_ORIGIN: "https://app.tearleads.de",
    DB: database,
    EMAIL: {} as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: inboundEmailDomain,
    STORAGE: storage,
  };
}

async function createDatabase() {
  const database = await migratedDatabase();
  database
    .query(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    )
    .run(
      organizationId,
      "Organization",
      organizationId,
      "2026-09-23T00:00:00Z",
    );
  const statements: CapturedStatement[] = [];
  const value = createTestD1(database, {
    beforeExecute: (query, values) => {
      if (!query.startsWith('select "id" from "organization"')) {
        statements.push({ query, values });
      }
    },
  });
  return { statements, value };
}

function createStorage() {
  const objects = new Map<string, Uint8Array>();
  const value = {
    delete: async (key: string) => {
      objects.delete(key);
    },
    put: async (key: string, content: unknown) => {
      objects.set(key, await toBytes(content));
      return {};
    },
  } as unknown as R2Bucket;
  return { objects, value };
}

function createMessage(raw: string, to = recipient) {
  let rejection: string | undefined;
  const message = {
    from: "sender@example.com",
    headers: new Headers(),
    raw: new Blob([raw]).stream(),
    rawSize: new TextEncoder().encode(raw).byteLength,
    setReject: (reason: string) => {
      rejection = reason;
    },
    to,
  } as unknown as ForwardableEmailMessage;
  return { message, rejection: () => rejection };
}

async function toBytes(content: unknown): Promise<Uint8Array> {
  if (content instanceof ReadableStream) {
    throw new TypeError("R2 requires streams with a known length");
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(
      content.buffer,
      content.byteOffset,
      content.byteLength,
    );
  }
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  throw new TypeError("Unsupported R2 test value");
}
