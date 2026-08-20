import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuditDefinition } from "./auditDefinition";
import { audits } from "./audits";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import type { Bindings } from "./types";

interface TemplateResponse {
  template: { definition: AuditDefinition; id: string; name: string };
}

interface TemplateListResponse {
  templates: Array<{
    definition: AuditDefinition;
    id: string;
    name: string;
  }>;
}

interface RunResponse {
  auditId: string;
}

interface IssueResponse {
  issueId: string;
}

describe("audits", () => {
  it("creates templates, snapshots audit runs, and tracks assigned issues", async () => {
    const fixture = await createFixture();
    const starterResponse = await fixture.app.request(
      "/templates",
      undefined,
      fixture.bindings,
    );
    expect(starterResponse.status).toBe(200);
    const starterBody = (await starterResponse.json()) as TemplateListResponse;
    expect(starterBody.templates).toHaveLength(1);
    expect(starterBody.templates[0]?.name).toBe("NFPA 70E readiness checklist");
    expect(starterBody.templates[0]?.definition.sections).toHaveLength(6);

    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Site walkthrough" },
    );
    expect(created.response.status).toBe(201);
    const template = created.body.template;
    template.definition.sections[0]?.items.push({
      id: "notes-item",
      prompt: "Record observations",
      required: false,
      responseType: "text",
    });

    const updated = await jsonRequest(
      fixture,
      `/templates/${template.id}`,
      "PUT",
      {
        definition: template.definition,
        description: "A small operational checklist.",
        name: template.name,
      },
    );
    expect(updated.response.status).toBe(200);

    const started = await jsonRequest<RunResponse>(
      fixture,
      `/templates/${template.id}/runs`,
      "POST",
    );
    expect(started.response.status).toBe(201);

    const incomplete = await jsonRequest(
      fixture,
      `/runs/${started.body.auditId}`,
      "PATCH",
      { responses: {}, status: "completed" },
    );
    expect(incomplete.response.status).toBe(400);

    const firstItem = template.definition.sections[0]?.items[0];
    expect(firstItem).toBeDefined();
    const saved = await jsonRequest(
      fixture,
      `/runs/${started.body.auditId}`,
      "PATCH",
      { responses: { [firstItem?.id ?? ""]: "fail" }, status: "in_progress" },
    );
    expect(saved.response.status).toBe(200);

    const issue = await jsonRequest<IssueResponse>(
      fixture,
      `/runs/${started.body.auditId}/issues`,
      "POST",
      {
        assignedTo: "user-1",
        description: "Correct before the next shift.",
        itemId: firstItem?.id,
        priority: "high",
        title: firstItem?.prompt,
      },
    );
    expect(issue.response.status).toBe(201);

    const detail = await fixture.app.request(
      `/runs/${started.body.auditId}`,
      undefined,
      fixture.bindings,
    );
    expect(await detail.json()).toMatchObject({
      audit: { responses: { [firstItem?.id ?? ""]: "fail" } },
      issues: [
        {
          assignedTo: "user-1",
          assigneeName: "Example Person",
          priority: "high",
          status: "open",
        },
      ],
      members: [{ id: "user-1", name: "Example Person" }],
    });

    const resolved = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { status: "resolved" },
    );
    expect(resolved.response.status).toBe(200);
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  await applyMigration(database, "0003_create_auth.sql");
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
      "user",
      false,
    );
  await applyMigration(database, "0004_create_organizations.sql");
  await applyMigration(database, "0005_create_audits.sql");
  const bindings = bindingsFor(database);
  const app = testApp();
  return { app, bindings };
}

function testApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", "org_user-1");
    context.set("authSession", {
      user: {
        defaultOrganizationId: "org_user-1",
        id: "user-1",
        role: "user",
      },
    } as unknown as AuthSession);
    await next();
  });
  app.route("/", audits);
  return app;
}

async function jsonRequest<T = unknown>(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  path: string,
  method: string,
  body?: unknown,
) {
  const init: RequestInit = {
    headers: { "content-type": "application/json" },
    method,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fixture.app.request(path, init, fixture.bindings);
  return { body: (await response.json()) as T, response };
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
