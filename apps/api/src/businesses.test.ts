import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { businesses, normalizeBusinessDate, normalizeEin } from "./businesses";
import type { Bindings } from "./types";

interface BusinessMutationBody {
  ein?: string | null;
  incorporationDate?: string | null;
  name: string;
  streetAddress?: string | null;
}

interface BusinessListResponse {
  businesses: Array<{
    ein: string | null;
    id: string;
    incorporationDate: string | null;
    name: string;
    streetAddress: string | null;
  }>;
  canManage: boolean;
}

interface BusinessResponse {
  business: {
    createdAt: string;
    ein: string | null;
    id: string;
    incorporationDate: string | null;
    name: string;
    streetAddress: string | null;
    updatedAt: string;
  };
}

describe("business EINs", () => {
  it("normalizes only valid nine-digit EINs", () => {
    expect(normalizeEin("12-3456789")).toBe("123456789");
    expect(normalizeEin(" 123456789 ")).toBe("123456789");
    expect(normalizeEin("12 3456789")).toBeNull();
    expect(normalizeEin("12345678")).toBeNull();
    expect(normalizeEin("12-345678a")).toBeNull();
  });
});

describe("business incorporation dates", () => {
  it("normalizes only real ISO calendar dates", () => {
    expect(normalizeBusinessDate(" 2024-02-29 ")).toBe("2024-02-29");
    expect(normalizeBusinessDate("2026-02-29")).toBeNull();
    expect(normalizeBusinessDate("2026-13-01")).toBeNull();
    expect(normalizeBusinessDate("08/22/2026")).toBeNull();
  });
});

describe("organization businesses", () => {
  it("creates multiple businesses without EINs", async () => {
    const fixture = await createFixture();
    const first = await create(fixture.ownerApp, fixture.bindings, {
      name: "Acme",
    });
    const second = await create(fixture.ownerApp, fixture.bindings, {
      ein: "",
      name: "Second Business",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(((await first.json()) as BusinessResponse).business).toMatchObject({
      ein: null,
      incorporationDate: null,
      streetAddress: null,
    });
    expect(((await second.json()) as BusinessResponse).business.ein).toBeNull();
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM businesses WHERE ein IS NULL")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("lets managers create multiple businesses and prevents duplicate EINs", async () => {
    const fixture = await createFixture();
    const first = await create(fixture.ownerApp, fixture.bindings, {
      ein: "12-3456789",
      incorporationDate: "2024-02-29",
      name: "  Acme, Inc.  ",
      streetAddress: "  123 Main Street  ",
    });
    expect(first.status).toBe(201);
    expect(((await first.json()) as BusinessResponse).business).toMatchObject({
      ein: "123456789",
      incorporationDate: "2024-02-29",
      name: "Acme, Inc.",
      streetAddress: "123 Main Street",
    });

    const second = await create(fixture.ownerApp, fixture.bindings, {
      ein: "987654321",
      name: "Second Business",
    });
    expect(second.status).toBe(201);

    const duplicate = await create(fixture.ownerApp, fixture.bindings, {
      ein: "12-3456789",
      name: "Duplicate",
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody: unknown = await duplicate.json();
    expect(duplicateBody).toEqual({
      error: "A business with that EIN already exists.",
    });

    const listed = await fixture.ownerApp.request(
      "/",
      undefined,
      fixture.bindings,
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as BusinessListResponse;
    expect(body.canManage).toBe(true);
    expect(body.businesses).toHaveLength(2);
    expect(body.businesses.map(({ name }) => name)).toContainAllValues([
      "Acme, Inc.",
      "Second Business",
    ]);

    const secondBusiness = body.businesses.find(
      ({ name }) => name === "Second Business",
    );
    if (!secondBusiness) throw new Error("Expected the second business.");
    const duplicateUpdate = await update(
      fixture.ownerApp,
      fixture.bindings,
      secondBusiness.id,
      { ein: "12-3456789", name: "Duplicate" },
    );
    expect(duplicateUpdate.status).toBe(409);
    const duplicateUpdateBody: unknown = await duplicateUpdate.json();
    expect(duplicateUpdateBody).toEqual({
      error: "A business with that EIN already exists.",
    });
  });

  it("lets managers edit optional business details", async () => {
    const fixture = await createFixture();
    const created = await create(fixture.ownerApp, fixture.bindings, {
      ein: "12-3456789",
      incorporationDate: "2020-01-15",
      name: "Acme",
      streetAddress: "123 Main Street",
    });
    const business = ((await created.json()) as BusinessResponse).business;

    const renamed = await update(
      fixture.ownerApp,
      fixture.bindings,
      business.id,
      { ein: "98-7654321", name: "  Acme Holdings  " },
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as BusinessResponse).business).toMatchObject(
      {
        createdAt: business.createdAt,
        ein: "987654321",
        id: business.id,
        incorporationDate: "2020-01-15",
        name: "Acme Holdings",
        streetAddress: "123 Main Street",
      },
    );

    const cleared = await update(
      fixture.ownerApp,
      fixture.bindings,
      business.id,
      {
        ein: null,
        incorporationDate: null,
        name: "Acme Holdings",
        streetAddress: null,
      },
    );
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as BusinessResponse).business.ein,
    ).toBeNull();
    expect(
      fixture.database
        .query(
          `SELECT name, ein, incorporation_date, street_address
           FROM businesses WHERE id = ?`,
        )
        .get(business.id),
    ).toEqual({
      ein: null,
      incorporation_date: null,
      name: "Acme Holdings",
      street_address: null,
    });
  });

  it("validates input and limits mutations to organization managers", async () => {
    const fixture = await createFixture();
    const invalidEin = await create(fixture.ownerApp, fixture.bindings, {
      ein: "not-an-ein",
      name: "Acme",
    });
    expect(invalidEin.status).toBe(400);

    const longName = await create(fixture.ownerApp, fixture.bindings, {
      ein: "123456789",
      name: "A".repeat(121),
    });
    expect(longName.status).toBe(400);

    const invalidDate = await create(fixture.ownerApp, fixture.bindings, {
      incorporationDate: "2026-02-29",
      name: "Acme",
    });
    expect(invalidDate.status).toBe(400);

    const longAddress = await create(fixture.ownerApp, fixture.bindings, {
      name: "Acme",
      streetAddress: "A".repeat(241),
    });
    expect(longAddress.status).toBe(400);

    const forbidden = await create(fixture.memberApp, fixture.bindings, {
      ein: "123456789",
      name: "Acme",
    });
    expect(forbidden.status).toBe(403);
    const forbiddenBody: unknown = await forbidden.json();
    expect(forbiddenBody).toEqual({
      error: "Organization manager access is required.",
    });

    const listed = await fixture.memberApp.request(
      "/",
      undefined,
      fixture.bindings,
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()) as BusinessListResponse).toEqual({
      businesses: [],
      canManage: false,
    });

    const created = await create(fixture.ownerApp, fixture.bindings, {
      name: "Acme",
    });
    const business = ((await created.json()) as BusinessResponse).business;
    const invalidUpdate = await update(
      fixture.ownerApp,
      fixture.bindings,
      business.id,
      { ein: "invalid", name: "Acme" },
    );
    expect(invalidUpdate.status).toBe(400);
    const forbiddenUpdate = await update(
      fixture.memberApp,
      fixture.bindings,
      business.id,
      { name: "Renamed" },
    );
    expect(forbiddenUpdate.status).toBe(403);
  });

  it("isolates organizations, scopes deletes, and cascades purged data", async () => {
    const fixture = await createFixture();
    const created = await create(fixture.ownerApp, fixture.bindings, {
      ein: "12-3456789",
      name: "Acme",
    });
    const business = ((await created.json()) as BusinessResponse).business;

    const otherList = await fixture.otherOwnerApp.request(
      "/",
      undefined,
      fixture.bindings,
    );
    expect((await otherList.json()) as BusinessListResponse).toEqual({
      businesses: [],
      canManage: true,
    });
    const otherDelete = await fixture.otherOwnerApp.request(
      `/${business.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(otherDelete.status).toBe(404);
    const otherUpdate = await update(
      fixture.otherOwnerApp,
      fixture.bindings,
      business.id,
      { name: "Other organization edit" },
    );
    expect(otherUpdate.status).toBe(404);

    const memberDelete = await fixture.memberApp.request(
      `/${business.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(memberDelete.status).toBe(403);

    fixture.database
      .query("DELETE FROM organization WHERE id = ?")
      .run("org_owner");
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM businesses").get(),
    ).toEqual({ count: 0 });
  });

  it("preserves existing businesses through business schema extensions", async () => {
    const database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    await applyMigration(database, "0003_create_auth.sql");
    insertUser(database, "owner");
    await applyMigration(database, "0004_create_organizations.sql");
    await applyMigration(database, "0015_create_businesses.sql");
    database
      .query(
        `INSERT INTO businesses
         (id, organization_id, name, ein, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-business",
        "org_owner",
        "Legacy Business",
        "123456789",
        "owner",
        timestamp,
        timestamp,
      );

    await applyMigration(database, "0017_make_business_ein_optional.sql");
    await applyMigration(database, "0018_add_business_details.sql");

    expect(
      database
        .query(
          `SELECT name, ein, incorporation_date, street_address
           FROM businesses WHERE id = ?`,
        )
        .get("legacy-business"),
    ).toEqual({
      ein: "123456789",
      incorporation_date: null,
      name: "Legacy Business",
      street_address: null,
    });
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigration(database, "0003_create_auth.sql");
  insertUser(database, "owner");
  insertUser(database, "member");
  insertUser(database, "other-owner");
  await applyMigration(database, "0004_create_organizations.sql");
  database
    .query(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("member-extra", "org_owner", "member", "member", timestamp);
  await applyMigration(database, "0015_create_businesses.sql");
  await applyMigration(database, "0017_make_business_ein_optional.sql");
  await applyMigration(database, "0018_add_business_details.sql");
  const bindings = bindingsFor(database);
  return {
    bindings,
    database,
    memberApp: testApp("org_owner", "member", "member"),
    otherOwnerApp: testApp("org_other-owner", "other-owner", "owner"),
    ownerApp: testApp("org_owner", "owner", "owner"),
  };
}

function insertUser(database: Database, id: string) {
  database
    .query(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      id,
      `${id}@example.com`,
      false,
      timestamp,
      timestamp,
      "user",
      false,
    );
}

function testApp(organizationId: string, userId: string, role: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", organizationId);
    context.set("organizationRole", role);
    context.set("authSession", {
      session: { activeOrganizationId: organizationId },
      user: { id: userId, role: "user" },
    } as unknown as AuthSession);
    await next();
  });
  app.route("/", businesses);
  return app;
}

function create(
  app: ReturnType<typeof testApp>,
  bindings: Bindings,
  body: BusinessMutationBody,
) {
  return app.request(
    "/",
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    bindings,
  );
}

function update(
  app: ReturnType<typeof testApp>,
  bindings: Bindings,
  id: string,
  body: BusinessMutationBody,
) {
  return app.request(
    `/${id}`,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    },
    bindings,
  );
}

function bindingsFor(database: Database): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.com",
    STORAGE: {} as R2Bucket,
  };
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

async function applyMigration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}

const timestamp = "2026-08-21T12:00:00.000Z";
