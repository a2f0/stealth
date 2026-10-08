import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { adminOrganizations } from "./adminOrganizations";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import type { Bindings } from "./types";

const proPriceId = "price_pro_test";
const targetOrganizationId = "org_member-user";

interface OrganizationDetailResponse {
  organization: Record<string, unknown>;
  members: Array<Record<string, unknown>>;
  requirements: Array<
    Record<string, unknown> & { checkrReportUrl: string | null }
  >;
}

describe("admin organizations", () => {
  it("opens another organization's people and checks without joining it", async () => {
    const database = await createDetailFixture();
    database
      .query(
        "DELETE FROM member WHERE userId = 'user-1' AND organizationId = ?",
      )
      .run(targetOrganizationId);
    const response = await testApp(database).request(
      `/${targetOrganizationId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrganizationDetailResponse;
    expect(body.organization).toMatchObject({
      id: targetOrganizationId,
      memberCount: 1,
      name: "Member Person's Organization",
    });
    expect(body.members).toEqual([
      {
        id: "member_member-user",
        role: "owner",
        twoFactorEnabled: false,
        twoFactorRequired: false,
        user: {
          id: "member-user",
          email: "member@example.com",
          name: "Member Person",
        },
      },
    ]);
    expect(body.requirements).toEqual([
      {
        id: "background-check",
        kind: "background_check",
        title: "Background check",
        dueDate: "2026-10-31",
        status: "complete",
        targetEmail: "member@example.com",
        targetName: "Member Person",
        completedAt: "2026-10-07T11:09:18.000Z",
        checkrInvitationStatus: "completed",
        checkrResult: "clear",
        checkrReportUrl:
          "https://dashboard.checkrhq-staging.net/reports/report%2F1",
      },
    ]);
    expect(
      database
        .query(
          "SELECT COUNT(*) AS count FROM member WHERE userId = 'user-1' AND organizationId = ?",
        )
        .get(targetOrganizationId),
    ).toEqual({ count: 0 });
    expect(
      database
        .query(
          "SELECT activeOrganizationId FROM session WHERE id = 'member-session'",
        )
        .get(),
    ).toEqual({ activeOrganizationId: targetOrganizationId });
  });

  it("uses the production Checkr dashboard for production reports", async () => {
    const database = await createDetailFixture();
    const response = await testApp(database, "production").request(
      `/${targetOrganizationId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrganizationDetailResponse;
    expect(body.requirements[0]?.checkrReportUrl).toBe(
      "https://dashboard.checkr.com/reports/report%2F1",
    );
  });

  it("keeps an unstarted check viewable after its member is removed", async () => {
    const database = await createDetailFixture();
    database
      .query(
        "UPDATE employee_requirements SET checkr_report_id = NULL, checkr_result = NULL, checkr_invitation_status = NULL, status = 'pending', completed_at = NULL WHERE id = 'background-check'",
      )
      .run();
    database.query("DELETE FROM member WHERE id = 'member_member-user'").run();
    const response = await testApp(database).request(
      `/${targetOrganizationId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrganizationDetailResponse;
    expect(body.requirements[0]).toMatchObject({
      targetEmail: "original@example.com",
      targetName: null,
      checkrReportUrl: null,
      checkrResult: null,
      status: "pending",
    });
  });

  it("returns not found for an unknown organization detail page", async () => {
    const database = await createDeletionFixture();
    const response = await testApp(database).request("/missing");
    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: "Organization not found." });
  });

  it("lists organizations with their owners and member counts", async () => {
    const database = new Database(":memory:");
    database.exec(
      await Bun.file(
        new URL("../migrations/0003_create_auth.sql", import.meta.url),
      ).text(),
    );
    database
      .query(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "user-1",
        "Example Person",
        "person@example.com",
        false,
        "2026-08-18T12:00:00.000Z",
        "2026-08-18T12:00:00.000Z",
        "admin",
        false,
      );
    database.exec(
      await Bun.file(
        new URL("../migrations/0004_create_organizations.sql", import.meta.url),
      ).text(),
    );
    database.exec(
      await Bun.file(
        new URL(
          "../migrations/0010_create_organization_groups.sql",
          import.meta.url,
        ),
      ).text(),
    );
    database.exec(
      await Bun.file(
        new URL(
          "../migrations/0011_soft_delete_organizations.sql",
          import.meta.url,
        ),
      ).text(),
    );
    database.exec(
      await Bun.file(
        new URL(
          "../migrations/0013_track_organization_deletion_actor.sql",
          import.meta.url,
        ),
      ).text(),
    );
    database.exec(
      await Bun.file(
        new URL(
          "../migrations/0014_restore_organization_defaults.sql",
          import.meta.url,
        ),
      ).text(),
    );

    const response = await testApp(database).request("/");

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      organizations: [
        {
          createdAt: "2026-08-18T12:00:00.000Z",
          deletedByEmail: null,
          deletedByName: null,
          deletedByUserId: null,
          deletedAt: null,
          id: "org_user-1",
          memberCount: 1,
          name: "Example Person's Organization",
          ownerEmail: "person@example.com",
          ownerName: "Example Person",
          slug: "personal-user-1",
        },
      ],
    });
  });

  it("marks an organization for deletion and records the admin", async () => {
    const database = await createDeletionFixture();
    const response = await testApp(database).request("/org_member-user", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deletedAt: string;
      deletedByEmail: string;
      deletedByName: string;
      deletedByUserId: string;
      organizationId: string;
    };
    expect(body).toEqual({
      deletedAt: body.deletedAt,
      deletedByEmail: "person@example.com",
      deletedByName: "Example Person",
      deletedByUserId: "user-1",
      organizationId: "org_member-user",
    });
    expect(new Date(body.deletedAt).toISOString()).toBe(body.deletedAt);
    expect(
      database
        .query(
          `SELECT deletedAt, deletedByUserId
           FROM organization WHERE id = ?`,
        )
        .get("org_member-user"),
    ).toEqual({
      deletedAt: body.deletedAt,
      deletedByUserId: "user-1",
    });

    const listing = await testApp(database).request("/");
    const listingBody = (await listing.json()) as {
      organizations: Array<Record<string, unknown>>;
    };
    expect(listingBody.organizations[0]).toMatchObject({
      deletedAt: body.deletedAt,
      deletedByEmail: "person@example.com",
      deletedByName: "Example Person",
      deletedByUserId: "user-1",
      id: "org_member-user",
    });
  });

  it("returns not found without creating billing for an unknown organization", async () => {
    const database = await createDeletionFixture();
    const response = await testApp(database).request("/org_missing", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count FROM organization_billing
           WHERE organization_id = 'org_missing'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("cancels paid billing before an admin deletes the organization", async () => {
    const database = await createDeletionFixture();
    insertPaidBilling(database);
    const originalFetch = globalThis.fetch;
    const requests: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ method: init?.method ?? "GET", url: String(input) });
      return Response.json(canceledSubscription());
    }) as typeof fetch;
    try {
      const response = await testApp(database).request(
        `/${targetOrganizationId}`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(200);
      expect(requests).toEqual([
        {
          method: "DELETE",
          url: "https://api.stripe.com/v1/subscriptions/sub_admin_test",
        },
      ]);
      expect(
        database
          .query(
            `SELECT organization.deletedAt, organization_billing.stripe_status
             FROM organization
             JOIN organization_billing
               ON organization_billing.organization_id = organization.id
             WHERE organization.id = ?`,
          )
          .get(targetOrganizationId),
      ).toMatchObject({
        deletedAt: expect.any(String),
        stripe_status: "canceled",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a paid organization when admin cancellation fails", async () => {
    const database = await createDeletionFixture();
    insertPaidBilling(database);
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = (async (_input, _init) =>
      Response.json(
        { error: { message: "Stripe unavailable" } },
        { status: 503 },
      )) as typeof fetch;
    console.error = () => {};
    try {
      const response = await testApp(database).request(
        `/${targetOrganizationId}`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(502);
      expect(
        database
          .query("SELECT deletedAt FROM organization WHERE id = ?")
          .get(targetOrganizationId),
      ).toEqual({ deletedAt: null });
    } finally {
      console.error = originalConsoleError;
      globalThis.fetch = originalFetch;
    }
  });

  it("re-enables checkout when deletion storage fails after cancellation", async () => {
    const database = await createDeletionFixture();
    insertPaidBilling(database);
    database.exec(
      `CREATE TRIGGER fail_admin_organization_deletion
       BEFORE UPDATE OF deletedAt ON organization
       WHEN NEW.deletedAt IS NOT NULL
       BEGIN
         SELECT RAISE(ABORT, 'forced organization deletion failure');
       END`,
    );
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = (async (_input, _init) =>
      Response.json(canceledSubscription())) as typeof fetch;
    console.error = () => {};
    try {
      const response = await testApp(database).request(
        `/${targetOrganizationId}`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(500);
      expect(
        database
          .query(
            `SELECT organization.deletedAt,
                    organization_billing.checkout_disabled_at,
                    organization_billing.stripe_status
             FROM organization
             JOIN organization_billing
               ON organization_billing.organization_id = organization.id
             WHERE organization.id = ?`,
          )
          .get(targetOrganizationId),
      ).toEqual({
        checkout_disabled_at: null,
        deletedAt: null,
        stripe_status: "canceled",
      });
    } finally {
      console.error = originalConsoleError;
      globalThis.fetch = originalFetch;
    }
  });

  it("restores a deleted organization without overriding other defaults", async () => {
    const database = await createDeletionFixture();
    const deletion = await testApp(database).request("/org_member-user", {
      method: "DELETE",
    });
    expect(deletion.status).toBe(200);
    expect(
      database
        .query(
          `SELECT defaultOrganizationId
           FROM user WHERE id = 'member-user'`,
        )
        .get(),
    ).toEqual({ defaultOrganizationId: null });
    expect(
      database
        .query(
          `SELECT activeOrganizationId
           FROM session WHERE userId = 'member-user'`,
        )
        .get(),
    ).toEqual({ activeOrganizationId: null });

    const response = await testApp(database).request(
      "/org_member-user/restore",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      organizationId: "org_member-user",
    });
    expect(
      database
        .query(
          `SELECT deletedAt, deletedByUserId
           FROM organization WHERE id = 'org_member-user'`,
        )
        .get(),
    ).toEqual({ deletedAt: null, deletedByUserId: null });
    expect(
      database
        .query(
          `SELECT defaultOrganizationId
           FROM user WHERE id = 'member-user'`,
        )
        .get(),
    ).toEqual({ defaultOrganizationId: "org_member-user" });
    expect(
      database
        .query(
          `SELECT activeOrganizationId, activeTeamId
           FROM session WHERE userId = 'member-user'`,
        )
        .get(),
    ).toEqual({
      activeOrganizationId: "org_member-user",
      activeTeamId: null,
    });
    expect(
      database
        .query(
          `SELECT checkout_disabled_at FROM organization_billing
           WHERE organization_id = 'org_member-user'`,
        )
        .get(),
    ).toEqual({ checkout_disabled_at: null });
    expect(
      database
        .query(
          `SELECT defaultOrganizationId
           FROM user WHERE id = 'user-1'`,
        )
        .get(),
    ).toEqual({ defaultOrganizationId: "org_user-1" });

    const repeated = await testApp(database).request(
      "/org_member-user/restore",
      { method: "POST" },
    );
    expect(repeated.status).toBe(409);
    database
      .query(
        `UPDATE organization_billing
         SET checkout_disabled_at = 'concurrent-deletion'
         WHERE organization_id = 'org_member-user'`,
      )
      .run();
    const concurrent = await testApp(database).request(
      "/org_member-user/restore",
      { method: "POST" },
    );
    expect(concurrent.status).toBe(409);
    expect(
      database
        .query(
          `SELECT checkout_disabled_at FROM organization_billing
           WHERE organization_id = 'org_member-user'`,
        )
        .get(),
    ).toEqual({ checkout_disabled_at: "concurrent-deletion" });
  });
});

async function createDeletionFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(
    await Bun.file(
      new URL("../migrations/0003_create_auth.sql", import.meta.url),
    ).text(),
  );
  for (const user of [
    ["user-1", "Example Person", "person@example.com", "admin"],
    ["member-user", "Member Person", "member@example.com", "user"],
  ]) {
    database
      .query(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES (?, ?, ?, 1, ?, ?, ?, 0)`,
      )
      .run(
        user[0] ?? "",
        user[1] ?? "",
        user[2] ?? "",
        "2026-08-18T12:00:00.000Z",
        "2026-08-18T12:00:00.000Z",
        user[3] ?? "user",
      );
  }
  database.exec(
    await Bun.file(
      new URL("../migrations/0004_create_organizations.sql", import.meta.url),
    ).text(),
  );
  database
    .query(
      `INSERT INTO member
       (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'member', ?)`,
    )
    .run(
      "admin-target-membership",
      "org_member-user",
      "user-1",
      "2026-08-18T12:00:00.000Z",
    );
  for (const migration of [
    "0010_create_organization_groups.sql",
    "0011_soft_delete_organizations.sql",
    "0013_track_organization_deletion_actor.sql",
    "0014_restore_organization_defaults.sql",
    "0032_create_billing.sql",
    "0053_track_paid_billing_end.sql",
  ]) {
    database.exec(
      await Bun.file(
        new URL(`../migrations/${migration}`, import.meta.url),
      ).text(),
    );
  }
  database
    .query(
      `INSERT INTO session
       (id, expiresAt, token, createdAt, updatedAt, userId,
        activeOrganizationId, activeTeamId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "member-session",
      "2027-08-18T12:00:00.000Z",
      "member-token",
      "2026-08-18T12:00:00.000Z",
      "2026-08-18T12:00:00.000Z",
      "member-user",
      "org_member-user",
      "team_finance_org_member-user",
    );
  return database;
}

async function createDetailFixture() {
  const database = await createDeletionFixture();
  for (const filename of [
    "0020_add_two_factor_authentication.sql",
    "0031_require_member_two_factor.sql",
    "0041_create_employee_requirements.sql",
    "0042_add_checkr_screenings.sql",
  ]) {
    database.exec(
      await Bun.file(
        new URL(`../migrations/${filename}`, import.meta.url),
      ).text(),
    );
  }
  database
    .query(
      `INSERT INTO employee_requirements
     (id, organization_id, member_id, target_email, kind, title, due_date, status,
      created_at, updated_at, completed_at, checkr_report_id, checkr_result,
      checkr_invitation_status)
     VALUES ('background-check', ?, 'member_member-user', 'original@example.com',
             'background_check', 'Background check', '2026-10-31', 'complete',
             '2026-10-07T11:00:00.000Z', '2026-10-07T11:09:18.000Z',
             '2026-10-07T11:09:18.000Z', 'report/1', 'clear', 'completed')`,
    )
    .run(targetOrganizationId);
  database
    .query(
      `INSERT INTO employee_requirements
     (id, organization_id, target_email, kind, title, due_date, created_at, updated_at)
     VALUES ('other-check', 'org_user-1', 'person@example.com', 'credit_check',
             'Private other check', '2026-10-01', '2026-10-01', '2026-10-01')`,
    )
    .run();
  return database;
}

function testApp(
  database: Database,
  checkrEnv: Bindings["CHECKR_ENV"] = "staging",
) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      user: {
        email: "person@example.com",
        id: "user-1",
        name: "Example Person",
        role: "admin",
      },
    } as AuthSession);
    await next();
  });
  app.route("/", adminOrganizations);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, {
        ...bindingsFor(database),
        CHECKR_ENV: checkrEnv,
      }),
  };
}

function bindingsFor(database: Database): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.de",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.de",
    STORAGE: {} as R2Bucket,
    STRIPE_PRO_PRICE_ID: proPriceId,
    STRIPE_SECRET_KEY: "sk_live_test",
  };
}

function insertPaidBilling(database: Database) {
  database
    .query(
      `INSERT INTO organization_billing
       (organization_id, stripe_customer_id, stripe_subscription_id,
        stripe_subscription_item_id, stripe_price_id, stripe_status,
        seat_quantity, stripe_event_created, updated_at)
       VALUES (?, 'cus_admin_test', 'sub_admin_test', 'si_admin_test', ?,
               'active', 1, 1, ?)`,
    )
    .run(targetOrganizationId, proPriceId, "2026-08-26T12:00:00.000Z");
}

function canceledSubscription() {
  return {
    cancel_at_period_end: false,
    customer: "cus_admin_test",
    id: "sub_admin_test",
    items: {
      data: [
        {
          id: "si_admin_test",
          price: { id: proPriceId },
          quantity: 1,
        },
      ],
    },
    metadata: { organization_id: targetOrganizationId },
    status: "canceled",
  };
}

function toD1(database: Database) {
  return {
    batch: async (statements: { execute: () => unknown }[]) =>
      statements.map((statement) => statement.execute()),
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
          const result = database.query(query).run(...values);
          return {
            meta: { changes: result.changes },
            results: [],
            success: true,
          };
        },
        first: async () => database.query(query).get(...values),
        run: async () => {
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}
