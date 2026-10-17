import { describe, expect, it } from "bun:test";
import { handleEmail } from "./email";
import type { Bindings } from "./types";

const organizationId = "organization-1";
const inboundEmailDomain = "inbox.balebase.com";
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
  it("rejects oversized headers before starting an upload", async () => {
    await expectRejectedMessage(
      `X-Large: ${"x".repeat(128 * 1024)}\r\n\r\nbody`,
      /Maximum header size/,
    );
  });

  it("rejects excessive MIME nesting before starting an upload", async () => {
    let raw = "Content-Type: text/plain\r\n\r\nbody";
    for (let depth = 0; depth < 32; depth++) {
      raw = `Content-Type: multipart/mixed; boundary="level-${depth}"\r\n\r\n--level-${depth}\r\n${raw}\r\n--level-${depth}--\r\n`;
    }
    await expectRejectedMessage(raw, /Maximum MIME nesting depth/);
  });

  it("stores an embedded message as an opaque attachment", async () => {
    const embedded = "Content-Type: text/html\r\n\r\n<p>nested body</p>\r\n";
    const raw = `Content-Type: message/rfc822\r\n\r\n${embedded}`;
    const database = createDatabase();
    const storage = createStorage();

    await handleEmail(
      createMessage(raw).message,
      createBindings(database.value, storage.value),
    );

    expect(storage.objects.size).toBe(2);
    expect(database.statements).toHaveLength(2);
    expect(database.statements[1]?.values[4]).toBe("message/rfc822");
    const attachment = [...storage.objects].find(([key]) =>
      key.includes("/attachments/"),
    );
    expect(new TextDecoder().decode(attachment?.[1])).toBe(embedded);
  });

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

async function expectRejectedMessage(raw: string, reason: RegExp) {
  const database = createDatabase();
  const storage = createStorage();
  await expect(
    handleEmail(
      createMessage(raw).message,
      createBindings(database.value, storage.value),
    ),
  ).rejects.toThrow(reason);
  expect(storage.uploads).toHaveLength(0);
  expect(storage.objects.size).toBe(0);
  expect(database.statements).toHaveLength(0);
}

function createBindings(database: D1Database, storage: R2Bucket): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.balebase.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.balebase.com",
    CORS_ORIGIN: "https://app.balebase.com",
    DB: database,
    EMAIL: {} as SendEmail,
    IMAGES: {} as ImagesBinding,
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
  const uploads: string[] = [];
  const value = {
    delete: async (key: string) => {
      objects.delete(key);
    },
    put: async (key: string, content: unknown) => {
      uploads.push(key);
      objects.set(key, await toBytes(content));
      return {};
    },
  } as unknown as R2Bucket;
  return { objects, uploads, value };
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
