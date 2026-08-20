import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { organizationGroups, requireCapability } from "./organizationGroups";
import { organizationSettings } from "./organizationSettings";
import type { Bindings } from "./types";

const organizationId = "org_owner-user";

describe("organization groups", () => {
  it("lets organization managers grant and revoke Finance access", async () => {
    const fixture = await createFixture();
    const owner = testApp(fixture.bindings, "owner-user");
    const member = testApp(fixture.bindings, "member-user");

    const listed = await jsonRequest<GroupListing>(owner, "/", "GET");
    expect(listed.response.status).toBe(200);
    expect(listed.body.groups).toMatchObject([
      {
        capabilities: ["finance"],
        memberUserIds: ["owner-user"],
        name: "Finance",
      },
    ]);
    expect(listed.body.members.map(({ user }) => user.id)).toEqual([
      "member-user",
      "owner-user",
    ]);
    const groupId = listed.body.groups[0]?.id;
    expect(groupId).toBeString();

    const memberAccess = await jsonRequest<AccessListing>(
      member,
      "/access",
      "GET",
    );
    expect(memberAccess.body.capabilities).toEqual([]);
    expect(memberAccess.body.memberRole).toBe("member");
    expect(memberAccess.body.ownerCount).toBe(1);
    expect((await jsonRequest(member, "/", "GET")).response.status).toBe(403);
    expect((await financeRequest(fixture.bindings, "member-user")).status).toBe(
      403,
    );

    const granted = await jsonRequest(owner, `/${groupId}`, "PATCH", {
      capabilities: ["finance"],
      name: "Finance",
      userIds: ["owner-user", "member-user"],
    });
    expect(granted.response.status).toBe(200);
    expect(
      (await jsonRequest<AccessListing>(member, "/access", "GET")).body
        .capabilities,
    ).toEqual(["finance"]);
    expect((await financeRequest(fixture.bindings, "member-user")).status).toBe(
      200,
    );

    const invalidMember = await jsonRequest(owner, `/${groupId}`, "PATCH", {
      capabilities: ["finance"],
      name: "Finance",
      userIds: ["outside-user"],
    });
    expect(invalidMember.response.status).toBe(400);

    const revoked = await jsonRequest(owner, `/${groupId}`, "PATCH", {
      capabilities: ["finance"],
      name: "Finance",
      userIds: ["owner-user"],
    });
    expect(revoked.response.status).toBe(200);
    expect((await financeRequest(fixture.bindings, "member-user")).status).toBe(
      403,
    );
  });

  it("aggregates members and manager-only pending invitations", async () => {
    const fixture = await createFixture();
    const owner = settingsApp(fixture.bindings, "owner-user");
    const member = settingsApp(fixture.bindings, "member-user");

    const ownerListing = await jsonRequest<PeopleListing>(
      owner,
      "/people",
      "GET",
    );
    expect(ownerListing.response.status).toBe(200);
    expect(ownerListing.body.memberRole).toBe("owner");
    expect(ownerListing.body.members.map(({ user }) => user.id)).toEqual([
      "member-user",
      "owner-user",
    ]);
    expect(ownerListing.body.invitations).toMatchObject([
      { email: "invited@example.com", role: "admin", status: "pending" },
    ]);

    const memberListing = await jsonRequest<PeopleListing>(
      member,
      "/people",
      "GET",
    );
    expect(memberListing.response.status).toBe(200);
    expect(memberListing.body.memberRole).toBe("member");
    expect(memberListing.body.members).toHaveLength(2);
    expect(memberListing.body.invitations).toEqual([]);
  });

  it("creates and deletes arbitrary organization groups", async () => {
    const fixture = await createFixture();
    const owner = testApp(fixture.bindings, "owner-user");
    const created = await jsonRequest<{ id: string }>(owner, "/", "POST", {
      capabilities: [],
      name: "Operations",
      userIds: ["member-user"],
    });
    expect(created.response.status).toBe(201);
    expect(
      (await jsonRequest<GroupListing>(owner, "/", "GET")).body.groups,
    ).toContainEqual(
      expect.objectContaining({
        memberUserIds: ["member-user"],
        name: "Operations",
      }),
    );
    const deleted = await owner.request(`/${created.body.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(
      (await jsonRequest<GroupListing>(owner, "/", "GET")).body.groups,
    ).not.toContainEqual(expect.objectContaining({ name: "Operations" }));
  });
});

interface GroupListing {
  groups: {
    capabilities: string[];
    id: string;
    memberUserIds: string[];
    name: string;
  }[];
  members: MemberListing[];
}

interface AccessListing {
  capabilities: string[];
  memberRole: string;
  ownerCount: number;
}

interface MemberListing {
  id: string;
  role: string;
  user: { email: string; id: string; name: string };
}

interface PeopleListing {
  invitations: {
    email: string;
    expiresAt: string;
    id: string;
    role: string;
    status: string;
  }[];
  memberRole: string;
  members: MemberListing[];
}

async function createFixture() {
  const database = new Database(":memory:");
  await applyMigration(database, "0003_create_auth.sql");
  insertUser(database, "owner-user", "owner@example.com");
  await applyMigration(database, "0004_create_organizations.sql");
  insertUser(database, "member-user", "member@example.com");
  insertUser(database, "outside-user", "outside@example.com");
  database
    .query(
      `INSERT INTO "member"
       ("id", "organizationId", "userId", "role", "createdAt")
       VALUES (?, ?, ?, 'member', ?)`,
    )
    .run("member-record", organizationId, "member-user", now());
  database
    .query(
      `INSERT INTO invitation
       (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
       VALUES (?, ?, ?, 'admin', 'pending', ?, ?, ?)`,
    )
    .run(
      "pending-invitation",
      organizationId,
      "invited@example.com",
      "2026-08-21T12:00:00.000Z",
      now(),
      "owner-user",
    );
  await applyMigration(database, "0010_create_organization_groups.sql");
  return { bindings: bindingsFor(database), database };
}

function insertUser(database: Database, id: string, email: string) {
  database
    .query(
      `INSERT INTO "user"
       ("id", "name", "email", "emailVerified", "createdAt", "updatedAt",
        "role", "banned") VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
    )
    .run(id, id, email, now(), now());
}

function testApp(bindings: Bindings, userId: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", sessionMiddleware(userId));
  app.route("/", organizationGroups);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
  };
}

function settingsApp(bindings: Bindings, userId: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", sessionMiddleware(userId));
  app.route("/", organizationSettings);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
  };
}

function financeRequest(bindings: Bindings, userId: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", sessionMiddleware(userId));
  app.use("/finance", requireCapability("finance"));
  app.get("/finance", (context) => context.json({ ok: true }));
  return app.request("/finance", undefined, bindings);
}

function sessionMiddleware(userId: string) {
  return async (
    context: {
      set: (
        key: keyof AuthVariables,
        value: AuthVariables[keyof AuthVariables],
      ) => void;
    },
    next: () => Promise<void>,
  ) => {
    context.set("organizationId", organizationId);
    context.set(
      "organizationRole",
      userId === "owner-user" ? "owner" : "member",
    );
    context.set("authSession", {
      user: { defaultOrganizationId: organizationId, id: userId, role: "user" },
    } as AuthSession);
    await next();
  };
}

async function jsonRequest<T = unknown>(
  app: ReturnType<typeof testApp>,
  path: string,
  method: string,
  body?: unknown,
) {
  const init: RequestInit = {
    headers: { "content-type": "application/json" },
    method,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(path, init);
  return { body: (await response.json()) as T, response };
}

function bindingsFor(database: Database) {
  return { DB: toD1(database) } as Bindings;
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
        execute: () => database.query(query).run(...values),
        first: async () => database.query(query).get(...values),
        run: async () => database.query(query).run(...values),
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

function now() {
  return "2026-08-19T12:00:00.000Z";
}
