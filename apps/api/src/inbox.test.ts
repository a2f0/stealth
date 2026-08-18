import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { inbox } from "./inbox";
import type { Bindings } from "./types";

const emailId = "email-1";
const attachmentId = "attachment-1";
const rawObjectKey = `inbound-emails/${emailId}/message.eml`;
const attachmentObjectKey = `inbound-emails/${emailId}/attachments/${attachmentId}`;
const rawEmail = [
  "From: Sender <sender@example.com>",
  "To: upload@inbox.tearleads.com",
  "Subject: Test attachment",
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

describe("inbox", () => {
  it("lists messages, renders a body, and downloads attachments", async () => {
    const fixture = await createFixture();

    const list = await inbox.request("/", undefined, fixture.bindings);
    expect(list.status).toBe(200);
    const listBody: unknown = await list.json();
    expect(listBody).toEqual({
      emails: [
        {
          attachmentCount: 1,
          from: "sender@example.com",
          id: emailId,
          rawSize: new TextEncoder().encode(rawEmail).byteLength,
          receivedAt: "2026-08-18T12:00:00.000Z",
          subject: "Test attachment",
          to: "upload@inbox.tearleads.com",
        },
      ],
    });

    const detail = await inbox.request(
      `/${emailId}`,
      undefined,
      fixture.bindings,
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      email: { attachments: object[]; text: string };
    };
    expect(detailBody.email.attachments).toEqual([
      {
        contentType: "text/plain",
        filename: "notes.txt",
        id: attachmentId,
        size: 16,
      },
    ]);
    expect(detailBody.email.text.trim()).toBe("Hello from the message body.");

    const attachment = await inbox.request(
      `/${emailId}/attachments/${attachmentId}`,
      undefined,
      fixture.bindings,
    );
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("content-disposition")).toContain(
      "notes.txt",
    );
    expect(await attachment.text()).toBe("hello attachment");
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  database.exec(
    await Bun.file(
      new URL("../migrations/0002_create_inbound_emails.sql", import.meta.url),
    ).text(),
  );
  database
    .query(
      `INSERT INTO inbound_emails
       (id, message_id, envelope_from, envelope_to, subject, raw_object_key,
        raw_size, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      emailId,
      "<test@example.com>",
      "sender@example.com",
      "upload@inbox.tearleads.com",
      "Test attachment",
      rawObjectKey,
      new TextEncoder().encode(rawEmail).byteLength,
      "2026-08-18T12:00:00.000Z",
    );
  database
    .query(
      `INSERT INTO inbound_email_attachments
       (id, email_id, object_key, filename, content_type, size, disposition,
        content_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      attachmentId,
      emailId,
      attachmentObjectKey,
      "notes.txt",
      "text/plain",
      16,
      "attachment",
      null,
      "2026-08-18T12:00:00.000Z",
    );

  const objects = new Map([
    [rawObjectKey, new TextEncoder().encode(rawEmail)],
    [attachmentObjectKey, new TextEncoder().encode("hello attachment")],
  ]);
  const bindings = {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    INBOUND_EMAIL_ADDRESS: "upload@inbox.tearleads.com",
    STORAGE: createStorage(objects),
  } satisfies Bindings;
  return { bindings };
}

function toD1(database: Database) {
  return {
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const statement = {
        all: async () => ({
          results: database.query(query).all(...values),
          success: true,
        }),
        bind: (...nextValues: SQLQueryBindings[]) => {
          values = nextValues;
          return statement;
        },
        first: async () => database.query(query).get(...values),
      };
      return statement;
    },
  } as unknown as D1Database;
}

function createStorage(objects: Map<string, Uint8Array>) {
  return {
    get: async (key: string) => {
      const content = objects.get(key);
      if (!content) return null;
      return {
        arrayBuffer: async () => content.slice().buffer,
        body: new Blob([content]).stream(),
        httpEtag: '"test-etag"',
        writeHttpMetadata: (headers: Headers) => {
          headers.set("content-type", "application/octet-stream");
        },
      };
    },
  } as unknown as R2Bucket;
}
