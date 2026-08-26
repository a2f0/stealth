import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { billing, handleStripeWebhook, syncOrganizationSeats } from "./billing";
import { purgeExpiredFreeAuditRuns } from "./billingRetention";
import type { Bindings } from "./types";

const organizationId = "org_user-1";
const proPriceId = "price_pro_test";

describe("billing", () => {
  it("reports Free entitlements and creates per-seat Checkout", async () => {
    const fixture = await createFixture();
    const summary = await fixture.app.request("/", undefined, fixture.bindings);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      current: { formTemplates: 0, members: 1 },
      limits: { formTemplates: 5, retentionDays: 30, users: 1 },
      plan: "free",
      pricing: { currency: "usd", proMonthlyPerSeat: 1_000 },
      seats: 1,
    });

    const originalFetch = globalThis.fetch;
    const checkoutRequests: URLSearchParams[] = [];
    globalThis.fetch = (async (_input, init) => {
      checkoutRequests.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        client_reference_id: organizationId,
        id: "cs_live_test",
        status: "open",
        url: "https://checkout.stripe.test/session",
      });
    }) as typeof fetch;
    try {
      const response = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect(response.status).toBe(200);
      const checkoutBody: unknown = await response.json();
      expect(checkoutBody).toEqual({
        url: "https://checkout.stripe.test/session",
      });
      expect(checkoutRequests[0]?.get("line_items[0][price]")).toBe(proPriceId);
      expect(checkoutRequests[0]?.get("line_items[0][quantity]")).toBe("1");
      expect(checkoutRequests[0]?.get("client_reference_id")).toBe(
        organizationId,
      );
      expect(
        checkoutRequests[0]?.get(
          "subscription_data[metadata][organization_id]",
        ),
      ).toBe(organizationId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses signed, idempotent, ordered webhooks as the entitlement source", async () => {
    const fixture = await createFixture();
    const active = subscriptionEvent("evt_active", 100, "active", 3);
    const first = await sendWebhook(fixture, active);
    expect(first.status).toBe(200);
    expect((await first.json()) as unknown).toEqual({ received: true });
    expect((await sendWebhook(fixture, active)).status).toBe(200);
    expect(
      fixture.database
        .query(
          `SELECT stripe_status, seat_quantity, stripe_event_created
           FROM organization_billing WHERE organization_id = ?`,
        )
        .get(organizationId),
    ).toEqual({
      seat_quantity: 3,
      stripe_event_created: 100,
      stripe_status: "active",
    });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM stripe_webhook_events")
        .get(),
    ).toEqual({ count: 1 });

    await sendWebhook(fixture, subscriptionEvent("evt_old", 99, "canceled", 3));
    expect(
      fixture.database
        .query(
          `SELECT stripe_status FROM organization_billing
           WHERE organization_id = ?`,
        )
        .get(organizationId),
    ).toEqual({ stripe_status: "active" });

    await sendWebhook(
      fixture,
      subscriptionEvent("evt_canceled", 101, "canceled", 3),
    );
    const summary = await fixture.app.request("/", undefined, fixture.bindings);
    expect(await summary.json()).toMatchObject({ plan: "free" });
  });

  it("synchronizes Stripe quantity to active organization members", async () => {
    const fixture = await createFixture();
    addMember(fixture.database, "user-2", organizationId);
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_customer_id, stripe_subscription_id,
          stripe_subscription_item_id, stripe_price_id, stripe_status,
          seat_quantity, stripe_event_created, updated_at)
         VALUES (?, 'cus_test', 'sub_test', 'si_test', ?, 'active', 1, 1, ?)`,
      )
      .run(organizationId, proPriceId, new Date().toISOString());
    const originalFetch = globalThis.fetch;
    const quantities: string[] = [];
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toContain("/v1/subscription_items/si_test");
      const quantity = new URLSearchParams(String(init?.body)).get("quantity");
      if (quantity) quantities.push(quantity);
      return Response.json({ id: "si_test", quantity: 2 });
    }) as typeof fetch;
    try {
      expect(
        await syncOrganizationSeats(fixture.bindings, organizationId),
      ).toBe(true);
      expect(quantities).toEqual(["2"]);
      expect(
        fixture.database
          .query(
            `SELECT seat_quantity FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ seat_quantity: 2 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("purges old Free audit history without touching Pro history", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_price_id, stripe_status, seat_quantity,
          stripe_event_created, updated_at)
         VALUES ('org_user-2', ?, 'active', 1, 1, ?)`,
      )
      .run(proPriceId, new Date().toISOString());
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_price_id, stripe_status, seat_quantity,
          stripe_event_created, updated_at)
         VALUES ('org_user-3', 'price_other', 'active', 1, 1, ?)`,
      )
      .run(new Date().toISOString());
    insertAudit(fixture.database, "free-old", organizationId, "2026-06-01");
    insertAudit(fixture.database, "free-recent", organizationId, "2026-08-20");
    insertAudit(fixture.database, "pro-old", "org_user-2", "2026-06-01");
    insertAudit(
      fixture.database,
      "other-price-old",
      "org_user-3",
      "2026-06-01",
    );

    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(2);
    expect(
      fixture.database.query("SELECT id FROM audits ORDER BY id").all(),
    ).toEqual([{ id: "free-recent" }, { id: "pro-old" }]);
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigration(database, "0003_create_auth.sql");
  for (const id of ["user-1", "user-2", "user-3"]) insertUser(database, id);
  await applyMigration(database, "0004_create_organizations.sql");
  await applyMigration(database, "0005_create_audits.sql");
  await applyMigration(database, "0011_soft_delete_organizations.sql");
  await applyMigration(database, "0022_version_audit_templates.sql");
  await applyMigration(database, "0031_create_billing.sql");
  const bindings = {
    AUTH_EMAIL_FROM: "security@auth.tearleads.test",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.tearleads.test",
    CORS_ORIGIN: "https://app.tearleads.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.test",
    STORAGE: {} as R2Bucket,
    STRIPE_PRO_PRICE_ID: proPriceId,
    STRIPE_SECRET_KEY: "sk_live_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  } satisfies Bindings;
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", organizationId);
    context.set("organizationRole", "owner");
    context.set("authSession", {
      user: { email: "user-1@example.com", id: "user-1", role: "user" },
    } as AuthSession);
    await next();
  });
  app.route("/", billing);
  const webhook = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  webhook.post("/", handleStripeWebhook);
  return { app, bindings, database, webhook };
}

function subscriptionEvent(
  id: string,
  created: number,
  status: string,
  quantity: number,
) {
  return {
    created,
    data: {
      object: {
        cancel_at_period_end: false,
        customer: "cus_test",
        id: "sub_test",
        items: {
          data: [
            {
              current_period_end: 1_800_000_000,
              id: "si_test",
              price: { id: proPriceId },
              quantity,
            },
          ],
        },
        metadata: { organization_id: organizationId },
        status,
      },
    },
    id,
    type: `customer.subscription.${status === "canceled" ? "deleted" : "updated"}`,
  };
}

async function sendWebhook(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  event: ReturnType<typeof subscriptionEvent>,
) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await webhookSignature(
    fixture.bindings.STRIPE_WEBHOOK_SECRET ?? "",
    timestamp,
    payload,
  );
  return fixture.webhook.request(
    "/",
    {
      body: payload,
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      method: "POST",
    },
    fixture.bindings,
  );
}

async function webhookSignature(
  secret: string,
  timestamp: number,
  payload: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${payload}`),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function insertUser(database: Database, id: string) {
  database
    .query(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
    )
    .run(
      id,
      id,
      `${id}@example.com`,
      new Date().toISOString(),
      new Date().toISOString(),
    );
}

function addMember(database: Database, userId: string, target: string) {
  database
    .query(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'member', ?)`,
    )
    .run(crypto.randomUUID(), target, userId, new Date().toISOString());
}

function insertAudit(
  database: Database,
  id: string,
  target: string,
  createdAt: string,
) {
  database
    .query(
      `INSERT INTO audits
       (id, organization_id, template_name, definition, responses, status,
        started_by, created_at, updated_at)
       VALUES (?, ?, 'Example form', '{"version":1,"sections":[]}', '{}',
               'completed', 'user-1', ?, ?)`,
    )
    .run(id, target, createdAt, createdAt);
}

interface TestStatement {
  execute: () => unknown;
}

function toD1(database: Database) {
  return {
    batch: async (statements: TestStatement[]) =>
      statements.map((statement) => statement.execute()),
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const statement = {
        all: async () => ({ results: database.query(query).all(...values) }),
        bind: (...nextValues: SQLQueryBindings[]) => {
          values = nextValues;
          return statement;
        },
        execute: () => {
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes } };
        },
        first: async <T>() => database.query(query).get(...values) as T | null,
        run: async () => {
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

async function applyMigration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}
