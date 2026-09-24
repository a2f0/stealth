import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import {
  assignAcceptedInvitationRequirements,
  employeeForms,
} from "./employeeForms";
import type { Bindings } from "./types";

const orgId = "org_owner";

describe("employee forms", () => {
  it("assigns invitation requirements and transfers them to the member", async () => {
    const fixture = await createFixture();
    const created = await fixture.app("owner", "owner").request("/", {
      body: JSON.stringify({
        invitationId: "invite",
        requirements: [
          { kind: "form", title: "W-4", dueDate: "2026-10-01" },
          {
            kind: "background_check",
            title: "Background check",
            dueDate: "2026-10-05",
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(created.status).toBe(201);
    const { ids } = (await created.json()) as { ids: string[] };
    expect(ids).toHaveLength(2);

    const before = await fixture.app("employee", "member").request("/");
    expect((await before.json()) as { requirements: unknown[] }).toEqual({
      requirements: [],
    });

    fixture.database
      .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
              VALUES ('new-member', ?, 'invitee', 'member', ?)`)
      .run(orgId, now());
    await assignAcceptedInvitationRequirements(
      fixture.bindings.DB,
      orgId,
      "invite",
      "new-member",
    );
    const after = await fixture.app("invitee", "member").request("/");
    const body = (await after.json()) as {
      requirements: Array<{ id: string; title: string }>;
    };
    expect(body.requirements.map(({ id }) => id)).toEqual(ids);
    expect(body.requirements[0]?.title).toBe("W-4");
  });

  it("enforces organization scope, manager writes, and valid due dates", async () => {
    const fixture = await createFixture();
    const data = {
      memberId: "employee-member",
      requirements: [{ kind: "form", title: "W-9", dueDate: "2026-02-30" }],
    };
    const invalid = await fixture
      .app("owner", "owner")
      .request("/", jsonPost(data));
    expect(invalid.status).toBe(400);

    const forbidden = await fixture.app("employee", "member").request(
      "/",
      jsonPost({
        ...data,
        requirements: [{ kind: "form", title: "W-9", dueDate: "2026-10-02" }],
      }),
    );
    expect(forbidden.status).toBe(403);

    const otherOrg = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        memberId: "other-member",
        requirements: [{ kind: "form", title: "W-9", dueDate: "2026-10-02" }],
      }),
    );
    expect(otherOrg.status).toBe(404);

    const malformed = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        memberId: "employee-member",
        requirements: [{ kind: ["form"], title: "W-4", dueDate: "2026-10-02" }],
      }),
    );
    expect(malformed.status).toBe(400);
    const id = await createRequirement(fixture, "form", "W-4");
    const invalidStatus = await fixture
      .app("owner", "owner")
      .request(`/${id}`, {
        body: JSON.stringify({ status: ["complete"] }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
    expect(invalidStatus.status).toBe(400);
  });

  it("rejects an invitation accepted during requirement assignment", async () => {
    const fixture = await createFixture();
    fixture.beforeBatch(() => {
      fixture.database
        .query("UPDATE invitation SET status = 'accepted' WHERE id = 'invite'")
        .run();
    });
    const response = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        invitationId: "invite",
        requirements: [{ kind: "form", title: "W-4", dueDate: "2026-10-02" }],
      }),
    );
    expect(response.status).toBe(409);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM employee_requirements")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("preserves concurrent status and rejects review of a replaced form", async () => {
    const fixture = await createFixture();
    const checkId = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.beforeRun((query) => {
      if (query.includes("SET status = COALESCE")) {
        fixture.database
          .query(
            "UPDATE employee_requirements SET status = 'complete' WHERE id = ?",
          )
          .run(checkId);
      }
    });
    const dueDate = await fixture.app("owner", "owner").request(`/${checkId}`, {
      body: JSON.stringify({ dueDate: "2026-10-10" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(dueDate.status).toBe(200);
    expect(
      fixture.database
        .query(
          "SELECT status, due_date FROM employee_requirements WHERE id = ?",
        )
        .get(checkId),
    ).toEqual({ status: "complete", due_date: "2026-10-10" });

    const formId = await createRequirement(fixture, "form", "W-4");
    const form = new FormData();
    form.set("file", new File(["old"], "old.pdf", { type: "application/pdf" }));
    await fixture.app("employee", "member").request(`/${formId}/document`, {
      body: form,
      method: "POST",
    });
    fixture.beforeRun((query) => {
      if (query.includes("SET status = COALESCE")) {
        fixture.database
          .query(
            "UPDATE employee_requirements SET document_key = 'new-key', document_revision = document_revision + 1 WHERE id = ?",
          )
          .run(formId);
      }
    });
    const review = await fixture.app("owner", "owner").request(`/${formId}`, {
      body: JSON.stringify({ status: "complete", documentRevision: 1 }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(review.status).toBe(409);
    expect(
      fixture.database
        .query("SELECT status FROM employee_requirements WHERE id = ?")
        .get(formId),
    ).toEqual({ status: "submitted" });
  });

  it("keeps submitted documents private and requires review before completion", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    const noFile = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(noFile.status).toBe(400);

    const form = new FormData();
    form.set(
      "file",
      new File(["form contents"], "tax.pdf", { type: "application/pdf" }),
    );
    const upload = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, {
        body: form,
        method: "POST",
      });
    expect(upload.status).toBe(200);
    const unrelated = await fixture
      .app("owner", "member")
      .request(`/${id}/document`);
    expect(unrelated.status).toBe(404);
    const download = await fixture
      .app("employee", "member")
      .request(`/${id}/document`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("form contents");
    expect(download.headers.get("cache-control")).toBe("private, no-store");

    const replacement = new FormData();
    replacement.set(
      "file",
      new File(["updated form"], "updated.pdf", { type: "application/pdf" }),
    );
    const replaced = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: replacement, method: "POST" });
    expect(replaced.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 1 });

    const staleReview = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete", documentRevision: 1 }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(staleReview.status).toBe(409);

    const reviewed = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete", documentRevision: 2 }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(reviewed.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT status FROM employee_requirements WHERE id = ?")
        .get(id),
    ).toEqual({ status: "complete" });
    fixture.database
      .query("DELETE FROM member WHERE id = 'employee-member'")
      .run();
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("starts and refreshes a Checkr screening with the configured package", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    fixture.bindings.CHECKR_ENV = "staging";
    fixture.bindings.CHECKR_CREDIT_PACKAGE = "employment_credit";
    const id = await createRequirement(fixture, "credit_check", "Credit check");
    const requests: Array<{
      url: string;
      body: string | null;
      idempotencyKey: string | null;
    }> = [];
    const screeningRace: { deletionStatus: number | null } = {
      deletionStatus: null,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: init?.body?.toString() ?? null,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
      });
      if (String(input).endsWith("/candidates"))
        return Response.json({ id: "candidate-1" });
      if (String(input).endsWith("/invitations") && init?.method === "POST") {
        screeningRace.deletionStatus = (
          await fixture.app("owner", "owner").request(`/${id}`, {
            method: "DELETE",
          })
        ).status;
        return Response.json({
          id: "invitation-1",
          report_id: null,
          status: "pending",
        });
      }
      if (String(input).endsWith("/invitations/invitation-1")) {
        return Response.json({
          id: "invitation-1",
          report_id: "report-1",
          status: "completed",
        });
      }
      return Response.json({
        id: "report-1",
        result: "consider",
        status: "complete",
      });
    }) as typeof fetch;
    try {
      const denied = await fixture
        .app("employee", "member")
        .request(
          `/${id}/checkr/start`,
          jsonPost({ state: "NY", city: "New York" }),
        );
      expect(denied.status).toBe(403);
      const started = await fixture
        .app("owner", "owner")
        .request(
          `/${id}/checkr/start`,
          jsonPost({ state: "NY", city: "New York" }),
        );
      expect(started.status).toBe(200);
      expect(screeningRace.deletionStatus).toBe(409);
      expect(requests[1]?.url).toBe(
        "https://api.checkr-staging.com/v1/invitations",
      );
      expect(requests[1]?.body).toContain("package=employment_credit");
      expect(requests[0]?.idempotencyKey).toBe(id);
      expect(requests[1]?.idempotencyKey).not.toBe(id);
      expect(requests[1]?.body).toContain("work_locations%5B%5D%5Bstate%5D=NY");
      const duplicate = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(duplicate.status).toBe(409);
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(refreshed.status).toBe(200);
      expect(
        fixture.database
          .query(
            "SELECT status, checkr_result FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ status: "complete", checkr_result: "consider" });
      const visible = await fixture.app("employee", "member").request("/");
      const body = (await visible.json()) as {
        requirements: Array<{ checkrResult: string | null }>;
      };
      expect(body.requirements[0]?.checkrResult).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("restarts an expired Checkr invitation with a new attempt", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    fixture.bindings.CHECKR_ENV = "staging";
    fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "background_package";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const invitationKeys: string[] = [];
    let invitationCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/candidates")) {
        return Response.json({ id: "candidate-1" });
      }
      if (url.endsWith("/invitations") && init?.method === "POST") {
        invitationCount += 1;
        invitationKeys.push(
          new Headers(init.headers).get("Idempotency-Key") ?? "",
        );
        return Response.json({
          id: `invitation-${invitationCount}`,
          report_id: null,
          status: "pending",
        });
      }
      if (url.endsWith("/invitations/invitation-1")) {
        return Response.json({
          id: "invitation-1",
          report_id: null,
          status: "expired",
        });
      }
      throw new Error(`Unexpected Checkr request: ${url}`);
    }) as typeof fetch;
    try {
      const first = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(first.status).toBe(200);
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(refreshed.status).toBe(200);
      const visible = await fixture.app("owner", "owner").request("/");
      const body = (await visible.json()) as {
        requirements: Array<{
          checkrStarted: boolean;
          checkrInvitationStatus: string;
          status: string;
        }>;
      };
      expect(body.requirements[0]).toMatchObject({
        checkrStarted: false,
        checkrInvitationStatus: "expired",
        status: "pending",
      });
      const restarted = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(restarted.status).toBe(200);
      expect(await restarted.json()).toMatchObject({
        invitationId: "invitation-2",
      });
      expect(invitationKeys).toHaveLength(2);
      expect(invitationKeys[0]).not.toBe(invitationKeys[1]);
      expect(
        fixture.database
          .query(
            "SELECT checkr_invitation_id, checkr_attempt FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_invitation_id: "invitation-2", checkr_attempt: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reconciles a lost Checkr response before allowing removal", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "background_package";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    let invitationPosts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/candidates")) {
        return Response.json({ id: "candidate-1" });
      }
      if (url.endsWith("/invitations") && init?.method === "POST") {
        invitationPosts += 1;
        return Response.json({ message: "response lost" }, { status: 504 });
      }
      if (url.includes("/invitations?candidate_id=")) {
        return Response.json({
          data: [
            {
              id: "invitation-1",
              report_id: null,
              status: "pending",
            },
          ],
        });
      }
      throw new Error(`Unexpected Checkr request: ${url}`);
    }) as typeof fetch;
    try {
      const failed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(failed.status).toBe(500);
      const removal = await fixture.app("owner", "owner").request(`/${id}`, {
        method: "DELETE",
      });
      expect(removal.status).toBe(409);
      const recovered = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        invitationId: "invitation-1",
      });
      expect(invitationPosts).toBe(1);
      expect(
        fixture.database
          .query(
            "SELECT checkr_start_nonce, checkr_invitation_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        checkr_start_nonce: null,
        checkr_invitation_id: "invitation-1",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("starts a new Checkr attempt after an old failed request is reconciled", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "background_package";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const invitationKeys: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/candidates")) {
        return Response.json({ id: "candidate-1" });
      }
      if (url.endsWith("/invitations") && init?.method === "POST") {
        invitationKeys.push(
          new Headers(init.headers).get("Idempotency-Key") ?? "",
        );
        if (invitationKeys.length === 1) {
          return Response.json({ message: "temporary error" }, { status: 503 });
        }
        return Response.json({
          id: "invitation-2",
          report_id: null,
          status: "pending",
        });
      }
      if (url.includes("/invitations?candidate_id=")) {
        return Response.json({ data: [] });
      }
      throw new Error(`Unexpected Checkr request: ${url}`);
    }) as typeof fetch;
    try {
      const first = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(first.status).toBe(500);
      fixture.database
        .query(
          "UPDATE employee_requirements SET checkr_start_nonce_at = ? WHERE id = ?",
        )
        .run(new Date(Date.now() - 25 * 60 * 60_000).toISOString(), id);
      const retry = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(retry.status).toBe(200);
      expect(invitationKeys).toHaveLength(2);
      expect(invitationKeys[0]).not.toBe(invitationKeys[1]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function createRequirement(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  kind: string,
  title: string,
) {
  const response = await fixture.app("owner", "owner").request(
    "/",
    jsonPost({
      memberId: "employee-member",
      requirements: [{ kind, title, dueDate: "2026-10-01" }],
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { ids: string[] }).ids[0] ?? "";
}

function jsonPost(body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  };
}

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await migration(database, "0003_create_auth.sql");
  for (const id of ["owner", "employee", "invitee", "other"]) {
    database
      .query(`INSERT INTO user
      (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
      VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`)
      .run(id, id, `${id}@example.com`, now(), now());
  }
  await migration(database, "0004_create_organizations.sql");
  database
    .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
    VALUES ('employee-member', ?, 'employee', 'member', ?)`)
    .run(orgId, now());
  database
    .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
    VALUES ('other-member', 'org_other', 'invitee', 'member', ?)`)
    .run(now());
  database
    .query(`INSERT INTO invitation
    (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
    VALUES ('invite', ?, 'invitee@example.com', 'member', 'pending', ?, ?, 'owner')`)
    .run(orgId, "2026-10-01", now());
  database.exec(`CREATE TABLE deleted_object_cleanup (
    id TEXT PRIMARY KEY, organization_id TEXT, object_key TEXT UNIQUE,
    deleted_at TEXT, cleanup_token TEXT, cleanup_claimed_at TEXT)`);
  await migration(database, "0041_create_employee_requirements.sql");
  await migration(database, "0042_add_checkr_screenings.sql");
  await migration(database, "0043_queue_employee_document_cleanup.sql");
  await migration(database, "0044_guard_employee_screenings.sql");
  const files = new Map<string, File>();
  const hooks: {
    beforeBatch: (() => void) | undefined;
    beforeRun: ((query: string) => void) | undefined;
  } = { beforeBatch: undefined, beforeRun: undefined };
  const bindings = {
    DB: toD1(database, hooks),
    STORAGE: {
      put: async (key: string, file: File) => {
        files.set(key, file);
      },
      delete: async (key: string) => {
        files.delete(key);
      },
      get: async (key: string) => {
        const file = files.get(key);
        return file
          ? {
              body: file.stream(),
              writeHttpMetadata: (headers: Headers) => {
                headers.set("content-type", file.type);
              },
            }
          : null;
      },
    },
  } as unknown as Bindings;
  return {
    app: (userId: string, role: string) => {
      const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
      app.use("*", async (context, next) => {
        context.set("organizationId", orgId);
        context.set("organizationRole", role);
        context.set("authSession", { user: { id: userId } } as AuthSession);
        await next();
      });
      app.route("/", employeeForms);
      return {
        request: (path: string, init?: RequestInit) =>
          app.request(path, init, bindings),
      };
    },
    bindings,
    beforeBatch: (callback: () => void) => {
      hooks.beforeBatch = callback;
    },
    beforeRun: (callback: (query: string) => void) => {
      hooks.beforeRun = callback;
    },
    database,
  };
}

function toD1(
  database: Database,
  hooks: {
    beforeBatch: (() => void) | undefined;
    beforeRun: ((query: string) => void) | undefined;
  },
) {
  return {
    batch: async (statements: Array<{ execute: () => unknown }>) => {
      const callback = hooks.beforeBatch;
      hooks.beforeBatch = undefined;
      callback?.();
      return statements.map((statement) => statement.execute());
    },
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const statement = {
        all: async () => ({ results: database.query(query).all(...values) }),
        bind: (...next: SQLQueryBindings[]) => {
          values = next;
          return statement;
        },
        execute: () => {
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes } };
        },
        first: async () => database.query(query).get(...values),
        run: async () => {
          const callback = hooks.beforeRun;
          hooks.beforeRun = undefined;
          callback?.(query);
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

async function migration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}

function now() {
  return "2026-09-24T12:00:00.000Z";
}
