import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, expect, it, spyOn } from "bun:test";
import { readdir } from "node:fs/promises";
import { Hono } from "hono";
import { adminJobs } from "./adminJobs";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { runMaintenanceJob } from "./maintenance";
import type { Bindings } from "./types";
import { purgeRequestedUsers, userDeletion } from "./userDeletion";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const now = new Date("2026-09-28T12:00:00.000Z");
const origin = "https://app.example.com";

async function fixture(role = "admin", impersonatedBy?: string) {
  const database = new Database(":memory:");
  let beforeUserDelete: (() => void) | undefined;
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory.pathname))
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    database.exec(await Bun.file(new URL(file, directory)).text());
  }
  const bindings = {
    CORS_ORIGIN: origin,
    DB: {
      prepare(sql: string) {
        let values: SQLQueryBindings[] = [];
        const statement = {
          bind(...params: SQLQueryBindings[]) {
            values = params;
            return statement;
          },
          async all() {
            return { results: database.query(sql).all(...values) };
          },
          async first() {
            if (sql.startsWith("DELETE FROM user WHERE")) {
              const interleave = beforeUserDelete;
              beforeUserDelete = undefined;
              interleave?.();
            }
            return database.query(sql).get(...values);
          },
          async run() {
            const result = database.query(sql).run(...values);
            return { meta: { changes: result.changes } };
          },
        };
        return statement;
      },
    },
  } as unknown as Bindings;
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      user: { id: "actor", role },
      session: { impersonatedBy },
    } as unknown as AuthSession);
    await next();
  });
  app.route("/jobs", adminJobs);
  app.route("/deletion", userDeletion);
  function insertUser(id: string, requestedAt?: string, userRole = "user") {
    database
      .query(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role)
      VALUES (?, ?, ?, 1, ?, ?, ?)`)
      .run(
        id,
        id,
        `${id}@example.com`,
        now.toISOString(),
        now.toISOString(),
        userRole,
      );
    if (requestedAt)
      database
        .query(
          "INSERT INTO user_deletion_requests (user_id, requested_at) VALUES (?, ?)",
        )
        .run(id, requestedAt);
  }
  return {
    database,
    bindings,
    insertUser,
    beforeUserDelete(callback: () => void) {
      beforeUserDelete = callback;
    },
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext),
  };
}

function post(confirm: string, requestOrigin = origin) {
  return {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm }),
  };
}

it("only purges requested, aged accounts without active memberships or protected roles", async () => {
  const f = await fixture();
  f.insertUser("eligible", "2026-08-29T12:00:00.000Z");
  f.insertUser("recent", "2026-08-29T12:00:00.001Z");
  f.insertUser("unrequested");
  f.insertUser("admin", "2026-08-01", "user, admin");
  f.insertUser("system:protected", "2026-08-01");
  f.insertUser("member", "2026-08-01");
  f.database.exec(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('active', 'Active', 'active', '2026-01-01');
    INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', 'active', 'member', 'owner', '2026-01-01');
    INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('session', '2027-01-01', 'token', '2026-01-01', '2026-01-01', 'eligible');
    INSERT INTO account (id, issuer, accountId, providerId, userId, createdAt, updatedAt) VALUES ('account', 'credential', 'eligible', 'credential', 'eligible', '2026-01-01', '2026-01-01');`);
  expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
    purged: 1,
    blocked: 3,
  });
  expect(
    f.database.query("SELECT id FROM user WHERE id = 'eligible'").get(),
  ).toBeNull();
  expect(
    f.database.query("SELECT id FROM session WHERE userId = 'eligible'").get(),
  ).toBeNull();
  expect(
    f.database.query("SELECT id FROM account WHERE userId = 'eligible'").get(),
  ).toBeNull();
  expect(
    f.database
      .query(
        "SELECT user_id FROM user_deletion_requests WHERE user_id = 'eligible'",
      )
      .get(),
  ).toBeNull();
  for (const id of [
    "recent",
    "unrequested",
    "admin",
    "system:protected",
    "member",
  ]) {
    expect(
      f.database.query("SELECT id FROM user WHERE id = ?").get(id),
    ).not.toBeNull();
  }
});

it("preserves retained references and rotates blocked users so later requests can run", async () => {
  const f = await fixture();
  f.database.exec(
    "CREATE TABLE retained_test (user_id TEXT REFERENCES user(id) ON DELETE RESTRICT)",
  );
  for (let i = 0; i < 25; i++) {
    f.insertUser(`blocked-${i}`, "2026-07-01");
    f.database
      .query("INSERT INTO retained_test VALUES (?)")
      .run(`blocked-${i}`);
  }
  f.insertUser("later", "2026-08-01");
  expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
    purged: 0,
    blocked: 25,
  });
  expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
    purged: 1,
    blocked: 24,
  });
  expect(
    f.database.query("SELECT id FROM user WHERE id = 'blocked-0'").get(),
  ).not.toBeNull();
});

it.each([
  {
    name: "cancels deletion",
    sql: "DELETE FROM user_deletion_requests WHERE user_id = 'eligible'",
  },
  {
    name: "cancels and requests deletion again",
    sql: `DELETE FROM user_deletion_requests WHERE user_id = 'eligible';
      INSERT INTO user_deletion_requests (user_id, requested_at)
      VALUES ('eligible', '${now.toISOString()}')`,
  },
  {
    name: "gains admin access",
    sql: "UPDATE user SET role = 'user, admin' WHERE id = 'eligible'",
  },
  {
    name: "joins an active organization",
    sql: `INSERT INTO organization (id, name, slug, createdAt)
      VALUES ('active', 'Active', 'active', '2026-01-01');
      INSERT INTO member (id, organizationId, userId, role, createdAt)
      VALUES ('membership', 'active', 'eligible', 'member', '2026-01-01')`,
  },
])(
  "preserves a selected account that $name before deletion",
  async ({ sql }) => {
    const f = await fixture();
    f.insertUser("eligible", "2026-08-01");
    let interleaved = false;
    f.beforeUserDelete(() => {
      expect(
        f.database
          .query(
            "SELECT last_attempted_at FROM user_deletion_requests WHERE user_id = 'eligible'",
          )
          .get(),
      ).toEqual({ last_attempted_at: now.toISOString() });
      f.database.exec(sql);
      interleaved = true;
    });
    expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
      purged: 0,
      blocked: 1,
    });
    expect(interleaved).toBe(true);
    expect(
      f.database.query("SELECT id FROM user WHERE id = 'eligible'").get(),
    ).not.toBeNull();
  },
);

it("records a user's own request once and permits cancellation", async () => {
  const f = await fixture("user");
  f.insertUser("actor");
  expect(
    (
      await f.request(
        "/deletion",
        post("delete my account", "https://evil.example"),
      )
    ).status,
  ).toBe(403);
  expect((await f.request("/deletion", post("wrong"))).status).toBe(400);
  expect((await f.request("/deletion", post("delete my account"))).status).toBe(
    200,
  );
  f.database
    .query("UPDATE user_deletion_requests SET requested_at = '2026-08-01'")
    .run();
  await f.request("/deletion", post("delete my account"));
  const status: unknown = await (await f.request("/deletion")).json();
  expect(status).toEqual({
    requestedAt: "2026-08-01",
  });
  expect(
    (
      await f.request("/deletion", {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
  ).toBe(200);
  expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
    purged: 0,
    blocked: 0,
  });
});

it("rejects deletion requests from impersonated sessions", async () => {
  const f = await fixture("user", "admin-id");
  f.insertUser("actor");
  expect((await f.request("/deletion", post("delete my account"))).status).toBe(
    403,
  );
});

it("requires root admin access, trusted origin, a known job, and explicit confirmation", async () => {
  const regular = await fixture("user");
  expect((await regular.request("/jobs")).status).toBe(403);
  expect(
    (
      await regular.request(
        "/jobs/purgeRequestedUsers/run",
        post("purgeRequestedUsers"),
      )
    ).status,
  ).toBe(403);
  const admin = await fixture();
  expect((await admin.request("/jobs")).status).toBe(200);
  expect(
    (
      await admin.request(
        "/jobs/purgeRequestedUsers/run",
        post("purgeRequestedUsers", "https://evil.example"),
      )
    ).status,
  ).toBe(403);
  expect(
    (await admin.request("/jobs/unknown/run", post("unknown"))).status,
  ).toBe(404);
  expect(
    (await admin.request("/jobs/purgeRequestedUsers/run", post("wrong")))
      .status,
  ).toBe(400);
  const response = await admin.request(
    "/jobs/purgeRequestedUsers/run",
    post("purgeRequestedUsers"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    run: {
      status: "succeeded",
      actorUserId: "actor",
      trigger: "manual",
      result: { purged: 0, blocked: 0 },
    },
  });
});

it("logs correlated start and completion records and sanitizes failed run responses", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const success = await runMaintenanceJob(
      "purgeDeletedObjects",
      async () => 3,
      { trigger: "manual", actorUserId: "actor" },
    );
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      runId: success.runId,
      status: "running",
      actorUserId: "actor",
    });
    expect(log.mock.calls[1]?.[0]).toMatchObject({
      runId: success.runId,
      status: "succeeded",
      result: 3,
    });
    const failure = await runMaintenanceJob(
      "purgeDeletedObjects",
      async () => {
        throw new Error("internal detail");
      },
      { trigger: "manual", actorUserId: "actor" },
    );
    expect(failure.status).toBe("failed");
    expect(JSON.stringify(failure)).not.toContain("internal detail");
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      runId: failure.runId,
      status: "failed",
    });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

it("returns a failed run with its ID when a manual job fails", async () => {
  const f = await fixture();
  f.database.exec("DROP TABLE user_deletion_requests");
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await f.request(
      "/jobs/purgeRequestedUsers/run",
      post("purgeRequestedUsers"),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      run: { runId: string; status: string };
    };
    expect(body.run.status).toBe("failed");
    expect(body.run.runId).toBeString();
  } finally {
    error.mockRestore();
  }
});
