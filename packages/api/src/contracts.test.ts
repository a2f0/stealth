import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { Hono } from "hono";
import { degrees, PDFDocument } from "pdf-lib";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import {
  resumeStalledContracts,
  sendContractReminders,
} from "./contractReminders";
import { contracts } from "./contracts";
import type { TemplateDefinition } from "./contractTemplateDefinition";
import { signing } from "./signing";
import type { Bindings } from "./types";

const timestamp = "2026-09-20T12:00:00.000Z";
const png = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0ABQHsHwEAAAAASUVORK5CYII="}`;

interface SentEmail {
  attachments?: Array<{ filename: string; type: string }>;
  replyTo?: string;
  subject: string;
  text: string;
  to: { email: string; name: string };
}

interface Contract {
  document: { pageCount: number; sha256: string };
  events: Array<{ recipientId: string | null; type: string }>;
  fields: Array<{ id: string; recipientId: string; type: string }>;
  finalSha256: string | null;
  id: string;
  recipients: Array<{
    email: string;
    id: string;
    name: string;
    status: string;
  }>;
  status: string;
}

const signers = [
  { email: "sam@example.com", key: "sam", name: "Sam Signer", routingOrder: 1 },
  {
    email: "cai@example.com",
    key: "cai",
    name: "Cai Cosigner",
    routingOrder: 2,
  },
];

function draft(overrides: Record<string, unknown> = {}) {
  return {
    dueDate: "2026-10-01",
    fields: [
      {
        height: 0.05,
        page: 1,
        recipientKey: "sam",
        type: "signature",
        width: 0.3,
        x: 0.1,
        y: 0.8,
      },
      {
        height: 0.03,
        page: 1,
        recipientKey: "sam",
        type: "date_signed",
        width: 0.2,
        x: 0.5,
        y: 0.8,
      },
      {
        height: 0.03,
        label: "Title",
        page: 2,
        recipientKey: "sam",
        type: "text",
        width: 0.2,
        x: 0.1,
        y: 0.1,
      },
      {
        height: 0.05,
        page: 2,
        recipientKey: "cai",
        type: "signature",
        width: 0.3,
        x: 0.1,
        y: 0.8,
      },
      {
        height: 0.04,
        page: 2,
        recipientKey: "cai",
        type: "initials",
        width: 0.1,
        x: 0.6,
        y: 0.8,
      },
    ],
    message: "Please review before Friday.",
    recipients: signers,
    reminderIntervalDays: 2,
    signingOrder: "parallel",
    title: "Services agreement",
    ...overrides,
  };
}

describe("contracts", () => {
  it("uploads a PDF and validates drafts before sending", async () => {
    const fixture = await createFixture();
    expect(
      (await fixture.upload(new TextEncoder().encode("not a pdf"), "notes.txt"))
        .status,
    ).toBe(400);
    const created = await fixture.upload(
      await samplePdf(),
      "Services agreement.pdf",
    );
    expect(created.status).toBe(201);
    expect(created.body.contract).toMatchObject({
      document: { pageCount: 2 },
      events: [{ type: "created" }],
      status: "draft",
    });
    const id = created.body.contract.id;

    for (const [change, message] of [
      [{ title: "" }, "title"],
      [
        {
          recipients: [signers[0], { ...signers[1], email: "SAM@example.com" }],
        },
        "more than once",
      ],
      [{ fields: [{ ...draft().fields[0], page: 3 }] }, "page"],
      [{ fields: [{ ...draft().fields[0], x: 0.8 }] }, "edge"],
      [
        { fields: [{ ...draft().fields[0], recipientKey: "nobody" }] },
        "signer",
      ],
      [{ reminderIntervalDays: 45 }, "Reminders"],
      [{ dueDate: "2026-02-30" }, "due date"],
    ] as const) {
      const saved = await fixture.json<{ error: string }>(
        "PUT",
        `/api/contracts/${id}/draft`,
        draft(change),
      );
      expect(saved.status).toBe(400);
      expect(saved.body.error).toContain(message);
    }

    const saved = await fixture.json<{ contract: Contract }>(
      "PUT",
      `/api/contracts/${id}/draft`,
      draft({
        fields: draft().fields.filter(
          ({ recipientKey }) => recipientKey === "sam",
        ),
      }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.contract.recipients.map(({ name }) => name)).toEqual([
      "Sam Signer",
      "Cai Cosigner",
    ]);
    const unsent = await fixture.json<{ error: string }>(
      "POST",
      `/api/contracts/${id}/send`,
    );
    expect(unsent.status).toBe(400);
    expect(unsent.body.error).toBe("Place a signature field for Cai Cosigner.");

    // Drafts save half-filled signers; sending needs a name and an email.
    for (const [signer, message] of [
      [{ ...signers[1], name: "" }, "Every signer needs a name."],
      [
        { ...signers[1], email: "cai@" },
        "“Cai Cosigner” needs a valid email address.",
      ],
    ] as const) {
      const halfFilled = await fixture.json(
        "PUT",
        `/api/contracts/${id}/draft`,
        draft({ recipients: [signers[0], signer] }),
      );
      expect(halfFilled.status).toBe(200);
      const blocked = await fixture.json<{ error: string }>(
        "POST",
        `/api/contracts/${id}/send`,
      );
      expect(blocked.status).toBe(400);
      expect(blocked.body.error).toBe(message);
    }
    expect(fixture.emails).toEqual([]);
  });

  it("collects parallel signatures and completes with a stamped PDF", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(draft());
    const sent = await fixture.json<{ contract: Contract }>(
      "POST",
      `/api/contracts/${id}/send`,
    );
    expect(sent.body.contract.status).toBe("sent");
    expect(sent.body.contract.recipients.map(({ status }) => status)).toEqual([
      "sent",
      "sent",
    ]);
    expect(fixture.emails.map(({ to }) => to.email)).toEqual([
      "sam@example.com",
      "cai@example.com",
    ]);
    expect(fixture.emails[0]).toMatchObject({
      replyTo: "owner@example.com",
      subject: "Olivia Owner sent you “Services agreement” to sign",
    });
    expect(fixture.emails[0]?.text).toContain("Please review before Friday.");
    const samToken = tokenFrom(fixture.emails[0]);
    const caiToken = tokenFrom(fixture.emails[1]);

    const view = await fixture.json<{
      canSign: boolean;
      contract: { organizationName: string; senderName: string };
      fields: Array<{ id: string; type: string }>;
    }>("GET", `/api/signing/${samToken}`);
    expect(view.body).toMatchObject({
      canSign: true,
      contract: { organizationName: "Acme, Inc.", senderName: "Olivia Owner" },
    });
    expect(view.body.fields.map(({ type }) => type)).toEqual([
      "signature",
      "date_signed",
      "text",
    ]);
    const textField = view.body.fields.find(({ type }) => type === "text");
    expect(
      (await fixture.request(`/api/signing/${samToken}/document`)).status,
    ).toBe(200);

    for (const [body, message] of [
      [{ signature: png }, "Agree"],
      [{ consent: true }, "Adopt a signature"],
      [
        { consent: true, signature: "data:image/png;base64,AAAA" },
        "Adopt a signature",
      ],
      [{ consent: true, signature: png, values: {} }, "required"],
    ] as const) {
      const rejected = await fixture.json<{ error: string }>(
        "POST",
        `/api/signing/${samToken}/sign`,
        body,
      );
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain(message);
    }
    const first = await fixture.json<{ completed: boolean; status: string }>(
      "POST",
      `/api/signing/${samToken}/sign`,
      {
        consent: true,
        signature: png,
        values: { [textField?.id ?? ""]: "Director" },
      },
    );
    expect(first.body).toEqual({ completed: false, status: "signed" });
    expect(
      (
        await fixture.json("POST", `/api/signing/${samToken}/sign`, {
          consent: true,
          signature: png,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fixture.json("POST", `/api/signing/${caiToken}/sign`, {
          consent: true,
          signature: png,
        })
      ).status,
    ).toBe(400);

    fixture.emails.length = 0;
    const last = await fixture.json<{ completed: boolean }>(
      "POST",
      `/api/signing/${caiToken}/sign`,
      {
        consent: true,
        initials: png,
        signature: png,
      },
    );
    expect(last.body.completed).toBe(true);
    const detail = await fixture.json<{ contract: Contract }>(
      "GET",
      `/api/contracts/${id}`,
    );
    expect(detail.body.contract.status).toBe("completed");
    expect(detail.body.contract.finalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.body.contract.events.map(({ type }) => type)).toEqual([
      "created",
      "sent",
      "notified",
      "notified",
      "viewed",
      "signed",
      "signed",
      "completed",
    ]);
    expect(
      fixture.emails.map(({ subject, to }) => [to.email, subject]),
    ).toEqual([
      ["sam@example.com", "Completed: “Services agreement”"],
      ["cai@example.com", "Completed: “Services agreement”"],
      ["owner@example.com", "Completed: “Services agreement”"],
    ]);
    expect(fixture.emails[0]?.attachments?.[0]).toMatchObject({
      filename: "Services agreement (signed).pdf",
      type: "application/pdf",
    });

    const final = await fixture.request(`/api/signing/${samToken}/final`);
    expect(final.status).toBe(200);
    const signed = await PDFDocument.load(
      new Uint8Array(await final.arrayBuffer()),
    );
    expect(signed.getPageCount()).toBeGreaterThanOrEqual(3);
    expect((await fixture.request(`/api/contracts/${id}/final`)).status).toBe(
      200,
    );
    expect(
      (
        await fixture.json<{ canSign: boolean }>(
          "GET",
          `/api/signing/${caiToken}`,
        )
      ).body.canSign,
    ).toBe(false);
  });

  it("routes sequential signers one at a time", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(draft({ signingOrder: "sequential" }));
    await fixture.json("POST", `/api/contracts/${id}/send`);
    expect(fixture.emails.map(({ to }) => to.email)).toEqual([
      "sam@example.com",
    ]);
    const pending = await fixture.json<{ contract: Contract }>(
      "GET",
      `/api/contracts/${id}`,
    );
    expect(
      pending.body.contract.recipients.map(({ status }) => status),
    ).toEqual(["sent", "pending"]);

    const view = await fixture.json<{
      fields: Array<{ id: string; type: string }>;
    }>("GET", `/api/signing/${tokenFrom(fixture.emails[0])}`);
    const textField = view.body.fields.find(({ type }) => type === "text");
    await fixture.json(
      "POST",
      `/api/signing/${tokenFrom(fixture.emails[0])}/sign`,
      {
        consent: true,
        signature: png,
        values: { [textField?.id ?? ""]: "Director" },
      },
    );
    expect(fixture.emails.map(({ to }) => to.email)).toEqual([
      "sam@example.com",
      "cai@example.com",
    ]);
  });

  it("records declines, voids, and deletions", async () => {
    const fixture = await createFixture();
    const declinedId = await fixture.prepare(draft());
    await fixture.json("POST", `/api/contracts/${declinedId}/send`);
    const samToken = tokenFrom(fixture.emails[0]);
    fixture.emails.length = 0;
    expect(
      (
        await fixture.json("POST", `/api/signing/${samToken}/decline`, {
          reason: "Wrong rate",
        })
      ).status,
    ).toBe(200);
    expect(fixture.emails).toMatchObject([
      {
        subject: "Declined: “Services agreement”",
        to: { email: "owner@example.com" },
      },
    ]);
    expect(fixture.emails[0]?.text).toContain("Reason: Wrong rate");
    expect(
      (
        await fixture.json<{ contract: Contract }>(
          "GET",
          `/api/contracts/${declinedId}`,
        )
      ).body.contract.status,
    ).toBe("declined");
    expect(
      (
        await fixture.json("POST", `/api/signing/${samToken}/sign`, {
          consent: true,
          signature: png,
        })
      ).status,
    ).toBe(409);

    const voidedId = await fixture.prepare(draft());
    fixture.emails.length = 0;
    await fixture.json("POST", `/api/contracts/${voidedId}/send`);
    const voidedToken = tokenFrom(fixture.emails[0]);
    expect(
      (await fixture.json("DELETE", `/api/contracts/${voidedId}`)).status,
    ).toBe(409);
    fixture.emails.length = 0;
    const voided = await fixture.json<{ contract: Contract }>(
      "POST",
      `/api/contracts/${voidedId}/void`,
      {
        reason: "Terms changed",
      },
    );
    expect(voided.body.contract.status).toBe("voided");
    expect(fixture.emails.map(({ subject }) => subject)).toEqual([
      "Voided: “Services agreement”",
      "Voided: “Services agreement”",
    ]);
    expect(
      (
        await fixture.json<{ canSign: boolean; contract: { status: string } }>(
          "GET",
          `/api/signing/${voidedToken}`,
        )
      ).body,
    ).toMatchObject({ canSign: false, contract: { status: "voided" } });
    expect(
      (await fixture.request(`/api/signing/${voidedToken}/document`)).status,
    ).toBe(410);

    expect(
      (await fixture.json("DELETE", `/api/contracts/${voidedId}`)).status,
    ).toBe(204);
    expect(
      (await fixture.json("GET", `/api/contracts/${voidedId}`)).status,
    ).toBe(404);
    expect(
      fixture.database
        .query("SELECT id FROM deleted_object_cleanup WHERE id = ?")
        .get(`contract-document:${voidedId}`),
    ).toBeTruthy();
    expect(
      (await fixture.json("GET", `/api/signing/${voidedToken}`)).status,
    ).toBe(404);
  });

  it("reminds signers on their contract's schedule and on request", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(draft({ reminderIntervalDays: 2 }));
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const samToken = tokenFrom(fixture.emails[0]);
    const sentAt = Date.now();
    fixture.emails.length = 0;

    expect(
      await sendContractReminders(
        fixture.bindings,
        new Date(sentAt + 86_400_000),
      ),
    ).toBe(0);
    const later = new Date(sentAt + 2 * 86_400_000 + 3_600_000);
    expect(await sendContractReminders(fixture.bindings, later)).toBe(2);
    expect(fixture.emails.map(({ subject }) => subject)).toEqual([
      "Reminder: please sign “Services agreement”",
      "Reminder: please sign “Services agreement”",
    ]);
    expect(tokenFrom(fixture.emails[0])).toBe(samToken);
    expect(await sendContractReminders(fixture.bindings, later)).toBe(0);

    fixture.emails.length = 0;
    const throttled = await fixture.json<{ error: string }>(
      "POST",
      `/api/contracts/${id}/remind`,
    );
    expect(throttled.status).toBe(429);
    fixture.database
      .query("UPDATE contract_recipients SET last_reminded_at = ?")
      .run(new Date(Date.now() - 2 * 3_600_000).toISOString());
    // A double click reminds each signer once.
    const [manual, doubled] = await Promise.all([
      fixture.json<{ reminded: number }>("POST", `/api/contracts/${id}/remind`),
      fixture.json<{ reminded: number }>("POST", `/api/contracts/${id}/remind`),
    ]);
    expect(manual.body.reminded + (doubled.body.reminded ?? 0)).toBe(2);
    expect(fixture.emails).toHaveLength(2);
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/remind`)).status,
    ).toBe(429);
    await fixture.json("POST", `/api/contracts/${id}/void`, {});
    expect(
      await sendContractReminders(
        fixture.bindings,
        new Date(sentAt + 30 * 86_400_000),
      ),
    ).toBe(0);
  });

  it("finishes a contract whose completion failed after the last signature", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(solo());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const token = tokenFrom(fixture.emails[0]);
    fixture.emails.length = 0;
    fixture.storage.failWrites = true;
    const signed = await fixture.json<{ completed: boolean; status: string }>(
      "POST",
      `/api/signing/${token}/sign`,
      { consent: true, signature: png },
    );
    expect(signed.body).toEqual({ completed: false, status: "signed" });
    const hour = (count: number) => new Date(Date.now() + count * 3_600_000);
    expect(await resumeStalledContracts(fixture.bindings, hour(0))).toBe(0);
    expect(await statusOf(fixture, id)).toBe("sent");
    // An attempt is leased, so an overlapping run leaves it alone.
    expect(await resumeStalledContracts(fixture.bindings, hour(0))).toBe(0);

    fixture.storage.failWrites = false;
    expect(await resumeStalledContracts(fixture.bindings, hour(1))).toBe(1);
    expect(await statusOf(fixture, id)).toBe("completed");
    expect(fixture.emails.map(({ to }) => to.email)).toEqual([
      "sam@example.com",
      "owner@example.com",
    ]);
    expect(await resumeStalledContracts(fixture.bindings, hour(2))).toBe(0);
  });

  it("gives up on a contract that keeps failing to complete", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(solo());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    fixture.storage.failWrites = true;
    await fixture.json(
      "POST",
      `/api/signing/${tokenFrom(fixture.emails[0])}/sign`,
      { consent: true, signature: png },
    );
    for (let hour = 1; hour <= 7; hour++) {
      await resumeStalledContracts(
        fixture.bindings,
        new Date(Date.now() + hour * 3_600_000),
      );
    }
    expect(
      fixture.database
        .query("SELECT resume_attempts AS attempts FROM contracts WHERE id = ?")
        .get(id),
    ).toEqual({ attempts: 5 });
    expect(await statusOf(fixture, id)).toBe("sent");
  });

  it("refuses a send when the draft changes while it is validated", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(draft());
    // A save from another tab lands between validation and the send.
    fixture.onQuery = (query) => {
      if (query.includes("SET status = 'sent'")) {
        fixture.database
          .query("UPDATE contracts SET revision = revision + 1 WHERE id = ?")
          .run(id);
      }
    };
    const raced = await fixture.json<{ error: string }>(
      "POST",
      `/api/contracts/${id}/send`,
    );
    expect(raced.status).toBe(409);
    expect(raced.body.error).toContain("changed while it was being sent");
    expect(await statusOf(fixture, id)).toBe("draft");
    expect(fixture.emails).toEqual([]);
  });

  it("rejects adopted images that could not be stamped", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(solo());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const token = tokenFrom(fixture.emails[0]);
    const bytes = Uint8Array.from(atob(png.split(",")[1] ?? ""), (character) =>
      character.charCodeAt(0),
    );
    new DataView(bytes.buffer).setUint32(16, 20_000);
    const oversized = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    const rejected = await fixture.json<{ error: string }>(
      "POST",
      `/api/signing/${token}/sign`,
      { consent: true, signature: oversized },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe(
      "The adopted signature could not be read.",
    );
    expect(await statusOf(fixture, id)).toBe("sent");
  });

  it("retires signing links when the auth secret rotates", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(solo());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const original = tokenFrom(fixture.emails[0]);
    fixture.bindings.BETTER_AUTH_SECRET =
      "rotated-secret-rotated-secret-rotated";
    expect((await fixture.json("GET", `/api/signing/${original}`)).status).toBe(
      404,
    );

    fixture.emails.length = 0;
    fixture.database
      .query("UPDATE contract_recipients SET notified_at = ?")
      .run(new Date(Date.now() - 2 * 3_600_000).toISOString());
    const reminded = await fixture.json<{ reminded: number }>(
      "POST",
      `/api/contracts/${id}/remind`,
    );
    expect(reminded.body.reminded).toBe(1);
    const reissued = tokenFrom(fixture.emails[0]);
    expect(reissued).not.toBe(original);
    expect((await fixture.json("GET", `/api/signing/${reissued}`)).status).toBe(
      200,
    );
    expect((await fixture.json("GET", `/api/signing/${original}`)).status).toBe(
      404,
    );
  });

  it("stops contract activity when its organization is deleted", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(draft());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const token = tokenFrom(fixture.emails[0]);
    fixture.database
      .query("UPDATE organization SET deletedAt = ? WHERE id = 'org-1'")
      .run(timestamp);
    expect((await fixture.json("GET", `/api/signing/${token}`)).status).toBe(
      404,
    );
    expect(
      await sendContractReminders(
        fixture.bindings,
        new Date(Date.now() + 30 * 86_400_000),
      ),
    ).toBe(0);

    fixture.database.query("DELETE FROM organization WHERE id = 'org-1'").run();
    expect(
      fixture.database
        .query("SELECT object_key FROM deleted_object_cleanup")
        .all(),
    ).toEqual([
      {
        object_key: `organizations/org-1/contracts/${id}/original.pdf`,
      },
    ]);
  });

  it("keeps contracts and signing links within their organization", async () => {
    const fixture = await createFixture();
    const id = await fixture.prepare(draft());
    const outsider = fixture.as("other-user", "org-2");
    for (const [method, path] of [
      ["GET", `/api/contracts/${id}`],
      ["GET", `/api/contracts/${id}/document`],
      ["PUT", `/api/contracts/${id}/draft`],
      ["POST", `/api/contracts/${id}/send`],
      ["DELETE", `/api/contracts/${id}`],
    ] as const) {
      expect((await outsider.json(method, path, draft())).status).toBe(404);
    }
    expect(
      (await outsider.json<{ contracts: unknown[] }>("GET", "/api/contracts"))
        .body.contracts,
    ).toEqual([]);
    expect(
      (await fixture.request(`/api/signing/${"A".repeat(43)}`)).status,
    ).toBe(404);
    expect((await fixture.request("/api/signing/short")).status).toBe(404);
  });
});

/** One signer with one signature field. */
function solo() {
  return draft({ fields: [draft().fields[0]], recipients: [signers[0]] });
}

async function statusOf(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  id: string,
) {
  const detail = await fixture.json<{ contract: Contract }>(
    "GET",
    `/api/contracts/${id}`,
  );
  return detail.body.contract.status;
}

function tokenFrom(email: SentEmail | undefined) {
  const token = /\/sign\/([A-Za-z0-9_-]{43})/.exec(email?.text ?? "")?.[1];
  if (!token) throw new Error("No signing link in email.");
  return token;
}

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const directory = `${import.meta.dir}/../migrations`;
  for (const filename of (await readdir(directory)).sort()) {
    database.exec(await Bun.file(`${directory}/${filename}`).text());
  }
  seed(database);
  const emails: SentEmail[] = [];
  const stored = new Map<string, Uint8Array>();
  const storage = { failWrites: false };
  const bindings = {
    AUTH_EMAIL_FROM: "security@auth.tearleads.de",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database, (query) => fixture.onQuery?.(query)),
    EMAIL: {
      send: async (message: SentEmail) => {
        emails.push(message);
        return { messageId: `message-${emails.length}` };
      },
    } as unknown as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.de",
    STORAGE: storageFor(stored, storage),
  } satisfies Bindings;

  function as(userId: string, organizationId: string) {
    const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
    app.use("/api/contracts/*", async (context, next) => {
      context.set("organizationId", organizationId);
      context.set("organizationRole", "member");
      context.set("authSession", {
        user: { id: userId, role: "user" },
      } as unknown as AuthSession);
      await next();
    });
    app.use("/api/contracts", async (context, next) => {
      context.set("organizationId", organizationId);
      context.set("organizationRole", "member");
      context.set("authSession", {
        user: { id: userId, role: "user" },
      } as unknown as AuthSession);
      await next();
    });
    app.route("/api/contracts", contracts);
    app.route("/api/signing", signing);
    const request = (path: string, init?: RequestInit) =>
      app.request(path, init, bindings);
    const json = async <T = unknown>(
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const init: RequestInit = { method };
      if (body !== undefined && method !== "GET") {
        init.body = JSON.stringify(body);
        init.headers = {
          "cf-connecting-ip": "203.0.113.7",
          "content-type": "application/json",
        };
      }
      const response = await request(path, init);
      const text = await response.text();
      return {
        body: (text ? JSON.parse(text) : null) as T,
        status: response.status,
      };
    };
    const upload = async (bytes: Uint8Array, filename: string) => {
      const form = new FormData();
      form.set("file", new File([bytes], filename));
      const response = await request("/api/contracts", {
        body: form,
        method: "POST",
      });
      return {
        body: (await response.json()) as { contract: Contract },
        status: response.status,
      };
    };
    return { json, request, upload };
  }

  const owner = as("owner-user", "org-1");
  const fixture: { onQuery?: (query: string) => void } = {};
  return Object.assign(fixture, {
    ...owner,
    as,
    bindings,
    database,
    emails,
    storage,
    prepare: async (body: ReturnType<typeof draft>) => {
      const created = await owner.upload(
        await samplePdf(),
        "Services agreement.pdf",
      );
      const saved = await owner.json(
        "PUT",
        `/api/contracts/${created.body.contract.id}/draft`,
        body,
      );
      if (saved.status !== 200)
        throw new Error(`Draft not saved: ${JSON.stringify(saved.body)}`);
      return created.body.contract.id;
    },
    stored,
  });
}

function seed(database: Database) {
  const run = (query: string, ...values: SQLQueryBindings[]) =>
    database.query(query).run(...values);
  for (const [id, name, email] of [
    ["owner-user", "Olivia Owner", "owner@example.com"],
    ["other-user", "Oscar Other", "other@example.com"],
  ]) {
    run(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
      id ?? "",
      name ?? "",
      email ?? "",
      timestamp,
      timestamp,
    );
  }
  for (const [id, name] of [
    ["org-1", "Acme, Inc."],
    ["org-2", "Other Co"],
  ]) {
    run(
      `INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`,
      id ?? "",
      name ?? "",
      id ?? "",
      timestamp,
    );
  }
}

async function samplePdf() {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  document.addPage([612, 792]).setRotation(degrees(90));
  return document.save();
}

interface TestStatement {
  execute: () => { changes: number };
}

/** A D1 stand-in; `onQuery` runs before each statement executes. */
function toD1(database: Database, onQuery: (query: string) => void) {
  return {
    // D1 runs a batch as one transaction.
    batch: async (statements: TestStatement[]) =>
      database.transaction(() =>
        statements.map((statement) => ({
          meta: { changes: statement.execute().changes },
        })),
      )(),
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
        execute: () => {
          onQuery(query);
          return database.query(query).run(...values);
        },
        first: async () => database.query(query).get(...values),
        run: async () => {
          onQuery(query);
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes }, success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function storageFor(
  stored: Map<string, Uint8Array>,
  state: { failWrites: boolean },
) {
  return {
    delete: async (key: string) => stored.delete(key),
    get: async (key: string) => {
      const content = stored.get(key);
      if (!content) return null;
      return {
        arrayBuffer: async () => content.slice().buffer,
        body: new Blob([content]).stream(),
      };
    },
    put: async (key: string, value: Uint8Array | ArrayBuffer) => {
      if (state.failWrites) throw new Error("Storage is unavailable.");
      stored.set(
        key,
        new Uint8Array(value instanceof Uint8Array ? value : value),
      );
    },
  } as unknown as R2Bucket;
}

interface Template {
  currentVersion: number;
  definition: TemplateDefinition;
  document: { pageCount: number; sha256: string };
  id: string;
  name: string;
  version: number;
}

async function uploadTemplate(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  const form = new FormData();
  form.set("file", new File([await samplePdf()], "Employment agreement.pdf"));
  const response = await fixture.request("/api/contracts/templates", {
    body: form,
    method: "POST",
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { template: Template }).template;
}

function templateVersion(template: Template) {
  return {
    definition: {
      fields: draft().fields.map(({ recipientKey, ...field }) => ({
        ...field,
        roleKey: recipientKey,
      })),
      message: "Please review this agreement.",
      reminderIntervalDays: 3,
      roles: signers.map(({ key, routingOrder }) => ({
        key,
        label: key === "sam" ? "Employee" : "Company",
        routingOrder,
      })),
      signingOrder: "sequential",
    },
    description: "An agreement with fields already placed.",
    expectedCurrentVersion: template.currentVersion,
    name: "Employment agreement",
    sourceVersion: template.version,
  };
}

function roleMapping(version: number) {
  return {
    recipients: signers.map(({ key, name, email }) => ({
      email,
      name,
      roleKey: key,
    })),
    title: "Sam's employment agreement",
    version,
  };
}

describe("contract templates", () => {
  it("keeps versions immutable and maps every field through a role into an independent draft", async () => {
    const fixture = await createFixture();
    const first = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${first.id}`;
    const saved = await fixture.json<{ template: Template }>(
      "POST",
      `${path}/versions`,
      templateVersion(first),
    );
    expect(saved.status).toBe(201);
    const second = saved.body.template;
    expect(second.version).toBe(2);
    expect(second.definition.roles).toEqual([
      { key: "sam", label: "Employee", routingOrder: 1 },
      { key: "cai", label: "Company", routingOrder: 2 },
    ]);
    expect(JSON.stringify(second.definition)).not.toContain("sam@example.com");
    expect(JSON.stringify(second.definition)).not.toContain("Sam Signer");
    const created = await fixture.json<{ contractId: string }>(
      "POST",
      `${path}/contracts`,
      roleMapping(2),
    );
    expect(created.status).toBe(201);
    const id = created.body.contractId;
    const detail = await fixture.json<{
      contract: Contract & { template: { name: string; version: number } };
    }>("GET", `/api/contracts/${id}`);
    expect(detail.body.contract.status).toBe("draft");
    expect(detail.body.contract.fields).toHaveLength(5);
    expect(detail.body.contract.template).toEqual({
      name: "Employment agreement",
      version: 2,
    });
    const employee = detail.body.contract.recipients.find(
      (recipient) => recipient.email === "sam@example.com",
    );
    expect(
      detail.body.contract.fields.filter(
        (field) => field.recipientId === employee?.id,
      ),
    ).toHaveLength(3);
    expect(detail.body.contract.events[0]?.type).toBe("created_from_template");
    const changed = templateVersion(second);
    changed.definition.fields = [];
    changed.name = "New employment agreement";
    expect(
      (await fixture.json("POST", `${path}/versions`, changed)).status,
    ).toBe(201);
    expect(
      (await fixture.json<{ template: Template }>("GET", `${path}?version=1`))
        .body.template.definition.fields,
    ).toEqual([]);
    expect(
      (await fixture.json<{ template: Template }>("GET", `${path}?version=2`))
        .body.template,
    ).toEqual({ ...second, currentVersion: 3 });
    const history = await fixture.json<{
      versions: Array<{ version: number }>;
    }>("GET", `${path}/versions`);
    expect(history.body.versions.map(({ version }) => version)).toEqual([
      3, 2, 1,
    ]);
    const old = await fixture.json<{ contractId: string }>(
      "POST",
      `${path}/contracts`,
      roleMapping(2),
    );
    expect(old.status).toBe(201);
    expect(
      (
        await fixture.json<{ contract: Contract }>(
          "GET",
          `/api/contracts/${old.body.contractId}`,
        )
      ).body.contract.fields,
    ).toHaveLength(5);
    expect((await fixture.json("DELETE", path)).status).toBe(204);
    const queue = fixture.database
      .query("SELECT object_key FROM deleted_object_cleanup")
      .all() as Array<{ object_key: string }>;
    expect(queue).toHaveLength(1);
    fixture.stored.delete(queue[0]?.object_key ?? "");
    expect(
      (await fixture.request(`/api/contracts/${id}/document`)).status,
    ).toBe(200);
    expect(
      (
        await fixture.json<{ contract: Contract & { template: unknown } }>(
          "GET",
          `/api/contracts/${id}`,
        )
      ).body.contract.template,
    ).toEqual({ name: "Employment agreement", version: 2 });
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/send`)).status,
    ).toBe(200);
    expect(fixture.emails).toHaveLength(1);
    expect(fixture.emails[0]?.to.email).toBe("sam@example.com");
  });

  it("rejects stale saves and preserves the winner's version", async () => {
    const fixture = await createFixture();
    const template = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${template.id}`;
    const input = templateVersion(template);
    expect((await fixture.json("POST", `${path}/versions`, input)).status).toBe(
      201,
    );
    expect(
      (
        await fixture.json("POST", `${path}/versions`, {
          ...input,
          name: "Stale overwrite",
        })
      ).status,
    ).toBe(409);
    const current = await fixture.json<{ template: Template }>("GET", path);
    expect(current.body.template.currentVersion).toBe(2);
    expect(current.body.template.name).toBe("Employment agreement");
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM contract_template_versions")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("validates roles, boxes, and complete unique mappings without saving people in templates", async () => {
    const fixture = await createFixture();
    const template = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${template.id}`;
    const input = templateVersion(template);
    for (const definition of [
      { ...input.definition, roles: [] },
      {
        ...input.definition,
        roles: [input.definition.roles[0], input.definition.roles[0]],
      },
      {
        ...input.definition,
        fields: [{ ...input.definition.fields[0], roleKey: "missing" }],
      },
      {
        ...input.definition,
        fields: [{ ...input.definition.fields[0], page: 3 }],
      },
      {
        ...input.definition,
        fields: [{ ...input.definition.fields[0], x: 0.99 }],
      },
    ])
      expect(
        (
          await fixture.json("POST", `${path}/versions`, {
            ...input,
            definition,
          })
        ).status,
      ).toBe(400);
    expect((await fixture.json("POST", `${path}/versions`, input)).status).toBe(
      201,
    );
    const mapping = roleMapping(2);
    for (const recipients of [
      [],
      [mapping.recipients[0]],
      [mapping.recipients[0], mapping.recipients[0]],
      [{ ...mapping.recipients[0], name: "" }, mapping.recipients[1]],
      [{ ...mapping.recipients[0], email: "invalid" }, mapping.recipients[1]],
      [
        { ...mapping.recipients[0], email: "cai@example.com" },
        mapping.recipients[1],
      ],
    ])
      expect(
        (
          await fixture.json("POST", `${path}/contracts`, {
            ...mapping,
            recipients,
          })
        ).status,
      ).toBe(400);
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM contracts").get(),
    ).toEqual({ count: 0 });
    expect(fixture.stored.size).toBe(1);
  });

  it("scopes every template route to the active organization", async () => {
    const fixture = await createFixture();
    const template = await uploadTemplate(fixture);
    const outsider = fixture.as("other-user", "org-2");
    const path = `/api/contracts/templates/${template.id}`;
    for (const [method, route, body] of [
      ["GET", path, undefined],
      ["GET", `${path}/document`, undefined],
      ["GET", `${path}/versions`, undefined],
      ["POST", `${path}/versions`, templateVersion(template)],
      ["POST", `${path}/contracts`, roleMapping(1)],
      ["DELETE", path, undefined],
    ] as const)
      expect((await outsider.json(method, route, body)).status).toBe(404);
    expect(
      (
        await outsider.json<{ templates: unknown[] }>(
          "GET",
          "/api/contracts/templates",
        )
      ).body.templates,
    ).toEqual([]);
    expect((await fixture.json("GET", `${path}?version=bogus`)).status).toBe(
      400,
    );
    expect(
      (await fixture.json("GET", `${path}/document?version=bogus`)).status,
    ).toBe(400);
  });

  it("rolls back a failed copy and handles deletion while a contract is being created", async () => {
    const fixture = await createFixture();
    const template = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${template.id}`;
    await fixture.json("POST", `${path}/versions`, templateVersion(template));
    fixture.onQuery = (query) => {
      if (query.includes("INSERT INTO contract_fields"))
        throw new Error("Database unavailable");
    };
    expect(
      (
        await fixture.request(`${path}/contracts`, {
          body: JSON.stringify(roleMapping(2)),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
    ).toBe(500);
    expect(fixture.stored.size).toBe(1);
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM contracts").get(),
    ).toEqual({ count: 0 });
    fixture.onQuery = (query) => {
      if (!query.includes("INSERT INTO contracts")) return;
      delete fixture.onQuery;
      fixture.database
        .query("DELETE FROM contract_templates WHERE id = ?")
        .run(template.id);
    };
    expect(
      (await fixture.json("POST", `${path}/contracts`, roleMapping(2))).status,
    ).toBe(404);
    expect(fixture.stored.size).toBe(1);
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM contracts").get(),
    ).toEqual({ count: 0 });
  });

  it("queues template PDFs when an organization is purged", async () => {
    const fixture = await createFixture();
    const template = await uploadTemplate(fixture);
    await fixture.json(
      "POST",
      `/api/contracts/templates/${template.id}/versions`,
      templateVersion(template),
    );
    fixture.database.query("DELETE FROM organization WHERE id = 'org-1'").run();
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM contract_template_versions")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 1 });
  });
});
