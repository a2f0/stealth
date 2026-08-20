import { describe, expect, it } from "bun:test";
import { handleEmail } from "./email";
import type { Bindings } from "./types";

const organizationId = "organization-1";
const inboundEmailDomain = "inbox.tearleads.com";
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
  values: unknown[];
}

describe("inbound email", () => {
  it("stores the raw message, attachments, and metadata", async () => {
    const database = createDatabase();
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
    const database = createDatabase();
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
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.tearleads.com",
    CORS_ORIGIN: "https://app.tearleads.com",
    DB: database,
    EMAIL: {} as SendEmail,
    INBOUND_EMAIL_DOMAIN: inboundEmailDomain,
    STORAGE: storage,
  };
}

function createDatabase() {
  const statements: CapturedStatement[] = [];
  const value = {
    batch: async () => [],
    prepare: (query: string) => {
      let values: unknown[] = [];
      const statement = {
        bind: (...nextValues: unknown[]) => {
          values = nextValues;
          if (!query.includes("SELECT id FROM organization")) {
            statements.push({ query, values });
          }
          return statement;
        },
        first: async () =>
          values[0] === organizationId ? { id: organizationId } : null,
      };
      return statement;
    },
  } as unknown as D1Database;
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
