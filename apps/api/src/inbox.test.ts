import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { inbox } from "./inbox";
import type { Bindings } from "./types";

const organizationId = "org_owner-user";
const otherOrganizationId = "org_other-user";
const emailId = "email-1";
const attachmentId = "attachment-1";
const rawObjectKey = `inbound-emails/${emailId}/message.eml`;
const attachmentObjectKey = `inbound-emails/${emailId}/attachments/${attachmentId}`;
const otherEmailId = "email-2";
const otherAttachmentId = "attachment-2";
const otherRawObjectKey = `organizations/${otherOrganizationId}/inbound-emails/${otherEmailId}/message.eml`;
const otherAttachmentObjectKey = `organizations/${otherOrganizationId}/inbound-emails/${otherEmailId}/attachments/${otherAttachmentId}`;
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

    const list = await fixture.request("/");
    expect(list.status).toBe(200);
    const listBody: unknown = await list.json();
    expect(listBody).toEqual({
      address: `upload+${organizationId}@inbox.tearleads.com`,
      emails: [
        {
          attachmentCount: 1,
          deletedAt: null,
          deletedByEmail: null,
          deletedByName: null,
          deletedByUserId: null,
          from: "sender@example.com",
          id: emailId,
          rawSize: new TextEncoder().encode(rawEmail).byteLength,
          receivedAt: "2026-08-18T12:00:00.000Z",
          subject: "Test attachment",
          to: "upload@inbox.tearleads.com",
        },
      ],
    });

    const detail = await fixture.request(`/${emailId}`);
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

    const attachment = await fixture.request(
      `/${emailId}/attachments/${attachmentId}`,
    );
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("content-disposition")).toContain(
      "notes.txt",
    );
    expect(await attachment.text()).toBe("hello attachment");

    expect((await fixture.request(`/${otherEmailId}`)).status).toBe(404);
    expect(
      (
        await fixture.request(
          `/${otherEmailId}/attachments/${otherAttachmentId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      fixture.database
        .query("SELECT organization_id FROM inbound_emails WHERE id = ?")
        .get(emailId),
    ).toEqual({ organization_id: organizationId });
  });

  it("moves messages to trash, records the actor, and restores them", async () => {
    const fixture = await createFixture();

    const deleted = await fixture.request(`/${emailId}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as {
      deletedAt: string;
      deletedByUserId: string;
      emailId: string;
    };
    expect(deletedBody).toMatchObject({
      deletedByUserId: "owner-user",
      emailId,
    });
    expect(new Date(deletedBody.deletedAt).toString()).not.toBe("Invalid Date");

    const activeList = await fixture.request("/");
    expect((await activeList.json()) as { emails: unknown[] }).toMatchObject({
      emails: [],
    });
    expect((await fixture.request(`/${emailId}`)).status).toBe(404);
    expect(
      (await fixture.request(`/${emailId}/attachments/${attachmentId}`)).status,
    ).toBe(404);

    const trashList = await fixture.request("/?folder=trash");
    expect(trashList.status).toBe(200);
    const trashBody = (await trashList.json()) as {
      emails: Array<{
        deletedAt: string;
        deletedByEmail: string;
        deletedByName: string;
        deletedByUserId: string;
        id: string;
      }>;
    };
    expect(trashBody.emails).toEqual([
      expect.objectContaining({
        deletedAt: deletedBody.deletedAt,
        deletedByEmail: "owner-user@example.com",
        deletedByName: "owner-user",
        deletedByUserId: "owner-user",
        id: emailId,
      }),
    ]);
    expect((await fixture.request(`/${emailId}?folder=trash`)).status).toBe(
      200,
    );
    expect(
      (
        await fixture.request(
          `/${emailId}/attachments/${attachmentId}?folder=trash`,
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await fixture.request(`/${otherEmailId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect((await fixture.request("/?folder=archive")).status).toBe(400);

    const restored = await fixture.request(`/${emailId}/restore`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
    const restoredBody: unknown = await restored.json();
    expect(restoredBody).toEqual({ emailId });
    expect((await fixture.request(`/${emailId}`)).status).toBe(200);
    expect(
      fixture.database
        .query(
          `SELECT deleted_at, deleted_by_user_id
           FROM inbound_emails WHERE id = ?`,
        )
        .get(emailId),
    ).toEqual({ deleted_at: null, deleted_by_user_id: null });
    expect(
      (await fixture.request(`/${emailId}/restore`, { method: "POST" })).status,
    ).toBe(404);
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigration(database, "0002_create_inbound_emails.sql");
  await applyMigration(database, "0003_create_auth.sql");
  insertUser(database, "owner-user");
  insertUser(database, "other-user");
  await applyMigration(database, "0004_create_organizations.sql");
  database.exec('ALTER TABLE organization ADD COLUMN "deletedAt" DATE');
  database
    .query("UPDATE organization SET name = 'Tearleads, LLC' WHERE id = ?")
    .run(organizationId);
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
  await applyMigration(
    database,
    "0012_scope_inbound_emails_to_organizations.sql",
  );
  database
    .query(
      `INSERT INTO inbound_emails
       (id, organization_id, message_id, envelope_from, envelope_to, subject,
        raw_object_key, raw_size, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      otherEmailId,
      otherOrganizationId,
      "<other@example.com>",
      "other@example.com",
      `upload+${otherOrganizationId}@inbox.tearleads.com`,
      "Other organization",
      otherRawObjectKey,
      new TextEncoder().encode(rawEmail).byteLength,
      "2026-08-19T12:00:00.000Z",
    );
  database
    .query(
      `INSERT INTO inbound_email_attachments
       (id, email_id, object_key, filename, content_type, size, disposition,
        content_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      otherAttachmentId,
      otherEmailId,
      otherAttachmentObjectKey,
      "other.txt",
      "text/plain",
      16,
      "attachment",
      null,
      "2026-08-19T12:00:00.000Z",
    );
  await applyMigration(database, "0016_soft_delete_inbound_emails.sql");

  const objects = new Map([
    [rawObjectKey, new TextEncoder().encode(rawEmail)],
    [attachmentObjectKey, new TextEncoder().encode("hello attachment")],
    [otherRawObjectKey, new TextEncoder().encode(rawEmail)],
    [otherAttachmentObjectKey, new TextEncoder().encode("other attachment")],
  ]);
  const bindings = {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.com",
    STORAGE: createStorage(objects),
  } satisfies Bindings;
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", organizationId);
    context.set("organizationRole", "member");
    context.set("authSession", {
      session: { activeOrganizationId: organizationId },
      user: { id: "owner-user", role: "user" },
    } as unknown as AuthSession);
    await next();
  });
  app.route("/", inbox);
  return {
    database,
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
  };
}

function insertUser(database: Database, id: string) {
  const timestamp = "2026-08-18T12:00:00.000Z";
  database
    .query(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
    )
    .run(id, id, `${id}@example.com`, timestamp, timestamp);
}

async function applyMigration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
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
        run: async () => {
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes }, success: true };
        },
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
