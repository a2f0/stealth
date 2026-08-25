import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuditDefinition } from "./auditDefinition";
import {
  purgePendingAuditIssueImages,
  readBodyWithLimit,
} from "./auditIssueImages";
import { audits } from "./audits";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import type { Bindings } from "./types";

interface TemplateResponse {
  template: {
    currentVersion: number;
    definition: AuditDefinition;
    id: string;
    name: string;
    scope: "global" | "organization";
    version: number;
  };
}

interface TemplateListResponse {
  templates: Array<{
    definition: AuditDefinition;
    id: string;
    name: string;
    scope: "global" | "organization";
    version: number;
  }>;
}

interface TemplateVersionsResponse {
  versions: Array<{ createdBy: { id: string }; version: number }>;
}

interface RunResponse {
  auditId: string;
}

interface IssueResponse {
  issueId: string;
}

interface IssueImageResponse {
  image: { contentType: string; filename: string; id: string };
}

interface TestIdentity {
  organizationId?: string;
  role?: string;
  userId?: string;
}

describe("audits", () => {
  it("stops reading image uploads at the streaming byte limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
      },
    });
    expect(await readBodyWithLimit(stream, 7)).toBeNull();
    expect(cancelled).toBe(true);

    const exact = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3]));
        controller.close();
      },
    });
    expect(await readBodyWithLimit(exact, 3)).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
  });

  it("migrates existing templates and audit provenance into version one", async () => {
    const database = await createLegacyDatabase();
    const definition: AuditDefinition = {
      sections: [
        {
          id: "legacy-section",
          items: [
            {
              id: "legacy-item",
              prompt: "Legacy question",
              required: true,
              responseType: "check",
            },
          ],
          title: "Legacy section",
        },
      ],
      version: 1,
    };
    database
      .query(
        `INSERT INTO audit_templates
         (id, organization_id, name, description, definition, status,
          created_by, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, 'draft', ?, ?, ?)`,
      )
      .run(
        "legacy-template",
        "org_user-1",
        "Legacy form",
        JSON.stringify(definition),
        "user-1",
        "2026-08-18T12:00:00.000Z",
        "2026-08-19T12:00:00.000Z",
      );
    database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_id, template_name, definition,
          responses, status, started_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', 'in_progress', ?, ?, ?)`,
      )
      .run(
        "legacy-run",
        "org_user-1",
        "legacy-template",
        "Legacy form",
        JSON.stringify(definition),
        "user-1",
        "2026-08-20T12:00:00.000Z",
        "2026-08-20T12:00:00.000Z",
      );

    await applyMigration(database, "0022_version_audit_templates.sql");

    expect(
      database
        .query(
          `SELECT scope, organization_id, current_version
           FROM audit_template_families WHERE id = ?`,
        )
        .get("legacy-template"),
    ).toEqual({
      current_version: 1,
      organization_id: "org_user-1",
      scope: "organization",
    });
    expect(
      database
        .query(
          `SELECT template_family_id, template_version_id, template_version
           FROM audits WHERE id = ?`,
        )
        .get("legacy-run"),
    ).toEqual({
      template_family_id: "legacy-template",
      template_version: 1,
      template_version_id: "legacy-template:v1",
    });
  });

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
    expect(starterBody.templates[0]).toMatchObject({
      id: "nfpa70e_global",
      name: "NFPA 70E readiness checklist",
      scope: "global",
    });
    expect(starterBody.templates[0]?.definition.sections).toHaveLength(6);

    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Site walkthrough" },
    );
    expect(created.response.status).toBe(201);
    const template = created.body.template;
    expect(template).toMatchObject({
      currentVersion: 1,
      scope: "organization",
      version: 1,
    });
    template.definition.sections[0]?.items.push({
      id: "notes-item",
      prompt: "Record observations",
      required: false,
      responseType: "text",
    });

    const updated = await jsonRequest<TemplateResponse>(
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
    expect(updated.body.template).toMatchObject({
      currentVersion: 2,
      version: 2,
    });

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

    const invalidAssignee = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: "user-2" },
    );
    expect(invalidAssignee.response.status).toBe(400);

    const unassigned = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: null },
    );
    expect(unassigned.response.status).toBe(200);
    const reassigned = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: "user-1" },
    );
    expect(reassigned.response.status).toBe(200);

    const invalidImageForm = new FormData();
    invalidImageForm.set(
      "file",
      new File(["not an image"], "fake.png", { type: "image/png" }),
    );
    const invalidImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images`,
      { body: invalidImageForm, method: "POST" },
      fixture.bindings,
    );
    expect(invalidImage.status).toBe(400);
    expect(fixture.stored.size).toBe(0);

    const truncatedImageForm = new FormData();
    truncatedImageForm.set(
      "file",
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        "truncated.png",
        { type: "image/png" },
      ),
    );
    const truncatedImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images`,
      { body: truncatedImageForm, method: "POST" },
      fixture.bindings,
    );
    expect(truncatedImage.status).toBe(400);
    expect(fixture.stored.size).toBe(0);

    fixture.bindings.IMAGES = imagesFor({ width: 12_001 });
    const oversizedDimensions = await fixture.app.request(
      `/issues/${issue.body.issueId}/images`,
      { body: pngForm("too-wide.png"), method: "POST" },
      fixture.bindings,
    );
    expect(oversizedDimensions.status).toBe(400);
    expect(fixture.stored.size).toBe(0);
    fixture.bindings.IMAGES = imagesFor();

    const imageForm = new FormData();
    imageForm.set(
      "file",
      new File([pngBytes()], "electrical-panel.jpg", { type: "image/jpeg" }),
    );
    const uploaded = await fixture.app.request(
      `/issues/${issue.body.issueId}/images`,
      { body: imageForm, method: "POST" },
      fixture.bindings,
    );
    expect(uploaded.status).toBe(201);
    const uploadedBody = (await uploaded.json()) as IssueImageResponse;
    expect(uploadedBody.image).toMatchObject({
      contentType: "image/png",
      filename: "electrical-panel.png",
    });

    fixture.databaseControl.failNextImageInsert = true;
    fixture.storageControl.failNextDelete = true;
    const failedUploadCleanup = await fixture.app.request(
      `/issues/${issue.body.issueId}/images`,
      { body: pngForm("cleanup-retry.png"), method: "POST" },
      fixture.bindings,
    );
    expect(failedUploadCleanup.status).toBe(500);
    expect(fixture.stored.size).toBe(2);
    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count FROM objects
           WHERE deletion_pending = 1 AND kind = 'audit_issue_image'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(await purgePendingAuditIssueImages(fixture.bindings)).toBe(0);
    expect(
      await purgePendingAuditIssueImages(
        fixture.bindings,
        "9999-12-31T23:59:59.999Z",
      ),
    ).toBe(1);
    expect(fixture.stored.size).toBe(1);

    const concurrentUploads = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fixture.app.request(
          `/issues/${issue.body.issueId}/images`,
          {
            body: pngForm(`concurrent-${index}.png`),
            method: "POST",
          },
          fixture.bindings,
        ),
      ),
    );
    expect(
      concurrentUploads.filter(({ status }) => status === 201),
    ).toHaveLength(9);
    expect(
      concurrentUploads.filter(({ status }) => status === 409),
    ).toHaveLength(1);
    expect(fixture.stored.size).toBe(10);
    expect(
      fixture.database
        .query(`SELECT COUNT(*) AS count FROM audit_issue_images`)
        .get(),
    ).toEqual({ count: 10 });
    expect(
      fixture.database.query(`SELECT COUNT(*) AS count FROM objects`).get(),
    ).toEqual({ count: 10 });
    expect(
      fixture.database.query(`SELECT DISTINCT kind FROM objects`).all(),
    ).toEqual([{ kind: "audit_issue_image" }]);

    const fullIssueInvalidUpload = new FormData();
    fullIssueInvalidUpload.set(
      "file",
      new File(["not an image"], "invalid.png", { type: "image/png" }),
    );
    const rejectedBeforeProcessing = await fixture.app.request(
      `/issues/${issue.body.issueId}/images`,
      { body: fullIssueInvalidUpload, method: "POST" },
      fixture.bindings,
    );
    expect(rejectedBeforeProcessing.status).toBe(409);
    expect(fixture.stored.size).toBe(10);

    const hiddenImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      {
        headers: {
          "x-test-organization-id": "org_user-2",
          "x-test-user-id": "user-2",
        },
      },
      fixture.bindings,
    );
    expect(hiddenImage.status).toBe(404);

    const image = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      undefined,
      fixture.bindings,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toBe("no-store");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toContain("inline");

    const detail = await fixture.app.request(
      `/runs/${started.body.auditId}`,
      undefined,
      fixture.bindings,
    );
    const detailBody = (await detail.json()) as {
      issues: Array<{
        images: Array<{
          contentType: string;
          filename: string;
          id: string;
          uploadedBy: { id: string };
        }>;
      }>;
    };
    expect(detailBody).toMatchObject({
      audit: {
        responses: { [firstItem?.id ?? ""]: "fail" },
        templateId: template.id,
        templateVersion: 2,
      },
      issues: [
        {
          assignedTo: "user-1",
          assigneeName: "Example Person",
          description: "Correct before the next shift.",
          priority: "high",
          status: "open",
        },
      ],
      members: [{ id: "user-1", name: "Example Person" }],
    });
    expect(detailBody.issues[0]?.images).toHaveLength(10);
    expect(detailBody.issues[0]?.images).toContainEqual(
      expect.objectContaining({
        contentType: "image/png",
        filename: "electrical-panel.png",
        uploadedBy: expect.objectContaining({ id: "user-1" }),
      }),
    );

    fixture.database
      .query(`DELETE FROM member WHERE organizationId = ? AND userId = ?`)
      .run("org_user-1", "user-1");
    const resolved = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { status: "resolved" },
    );
    expect(resolved.response.status).toBe(200);
    expect(
      fixture.database
        .query(`SELECT assigned_to, status FROM audit_issues WHERE id = ?`)
        .get(issue.body.issueId),
    ).toEqual({ assigned_to: "user-1", status: "resolved" });

    fixture.databaseControl.failNextPendingUpdate = true;
    const failedMetadataDelete = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(failedMetadataDelete.status).toBe(500);
    expect(fixture.stored.size).toBe(10);
    const retainedImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      undefined,
      fixture.bindings,
    );
    expect(retainedImage.status).toBe(200);

    const uploadedObject = fixture.database
      .query(
        `SELECT id FROM objects
         WHERE object_key LIKE '%/electrical-panel.png'`,
      )
      .get() as { id: string };
    fixture.storageControl.failNextDelete = true;
    const failedImageDelete = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(failedImageDelete.status).toBe(202);
    expect(fixture.stored.size).toBe(10);
    expect(
      fixture.database
        .query(
          `SELECT deletion_pending FROM objects
           WHERE id = ? AND kind = 'audit_issue_image'`,
        )
        .get(uploadedObject.id),
    ).toEqual({ deletion_pending: 1 });
    expect(
      fixture.database
        .query(`SELECT id FROM audit_issue_images WHERE id = ?`)
        .get(uploadedBody.image.id),
    ).toBeNull();
    const pendingImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      undefined,
      fixture.bindings,
    );
    expect(pendingImage.status).toBe(404);
    const replacementImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images`,
      { body: pngForm("replacement.png"), method: "POST" },
      fixture.bindings,
    );
    expect(replacementImage.status).toBe(201);
    const replacementImageBody =
      (await replacementImage.json()) as IssueImageResponse;
    expect(fixture.stored.size).toBe(11);
    expect(await purgePendingAuditIssueImages(fixture.bindings)).toBe(0);
    expect(
      await purgePendingAuditIssueImages(
        fixture.bindings,
        "9999-12-31T23:59:59.999Z",
      ),
    ).toBe(1);
    expect(fixture.stored.size).toBe(10);

    const deletedImages = await Promise.all(
      (detailBody.issues[0]?.images ?? [])
        .filter(({ id }) => id !== uploadedBody.image.id)
        .map(({ id }) =>
          fixture.app.request(
            `/issues/${issue.body.issueId}/images/${id}`,
            { method: "DELETE" },
            fixture.bindings,
          ),
        ),
    );
    expect(deletedImages.every(({ status }) => status === 204)).toBe(true);
    const deletedReplacement = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${replacementImageBody.image.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deletedReplacement.status).toBe(204);
    expect(fixture.stored.size).toBe(0);
  });

  it("keeps every saved template version immutable", async () => {
    const fixture = await createFixture();
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Versioned form", scope: "organization" },
    );
    const first = created.body.template;
    const secondDefinition = structuredClone(first.definition);
    const firstItem = secondDefinition.sections[0]?.items[0];
    if (firstItem) firstItem.prompt = "Second version question";
    const second = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${first.id}`,
      "PUT",
      {
        definition: secondDefinition,
        description: "Second version",
        expectedCurrentVersion: 1,
        name: first.name,
      },
    );
    expect(second.body.template.version).toBe(2);

    const third = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${first.id}`,
      "PUT",
      {
        definition: first.definition,
        description: "Created from the first version",
        expectedCurrentVersion: 2,
        name: "Restored form",
      },
    );
    expect(third.body.template).toMatchObject({
      currentVersion: 3,
      name: "Restored form",
      version: 3,
    });

    const history = await jsonRequest<TemplateVersionsResponse>(
      fixture,
      `/templates/${first.id}/versions`,
      "GET",
    );
    expect(history.body.versions.map(({ version }) => version)).toEqual([
      3, 2, 1,
    ]);
    expect(
      history.body.versions.every(({ createdBy }) => createdBy.id === "user-1"),
    ).toBe(true);

    const original = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${first.id}/versions/1`,
      "GET",
    );
    expect(original.body.template).toMatchObject({
      currentVersion: 3,
      name: "Versioned form",
      version: 1,
    });
    expect(original.body.template.definition).toEqual(first.definition);

    const stale = await jsonRequest(fixture, `/templates/${first.id}`, "PUT", {
      definition: first.definition,
      expectedCurrentVersion: 2,
      name: "Stale form",
    });
    expect(stale.response.status).toBe(409);
  });

  it("allows every question to be removed from a section", async () => {
    const fixture = await createFixture();
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Empty section form" },
    );
    const definition = structuredClone(created.body.template.definition);
    const section = definition.sections[0];
    expect(section).toBeDefined();
    if (section) section.items = [];

    const saved = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${created.body.template.id}`,
      "PUT",
      {
        definition,
        expectedCurrentVersion: 1,
        name: created.body.template.name,
      },
    );
    expect(saved.response.status).toBe(200);
    expect(saved.body.template.definition.sections[0]?.items).toEqual([]);

    const started = await jsonRequest<RunResponse>(
      fixture,
      `/templates/${created.body.template.id}/runs`,
      "POST",
    );
    const completed = await jsonRequest(
      fixture,
      `/runs/${started.body.auditId}`,
      "PATCH",
      { responses: {}, status: "completed" },
    );
    expect(completed.response.status).toBe(200);
  });

  it("shares global templates without exposing organization templates", async () => {
    const fixture = await createFixture();
    const denied = await jsonRequest(fixture, "/templates", "POST", {
      name: "Unauthorized global form",
      scope: "global",
    });
    expect(denied.response.status).toBe(403);

    const global = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Shared safety form", scope: "global" },
      { role: "admin" },
    );
    expect(global.body.template.scope).toBe("global");

    const local = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Private form", scope: "organization" },
    );
    expect(local.response.status).toBe(201);

    const otherOrganization = await jsonRequest<TemplateListResponse>(
      fixture,
      "/templates",
      "GET",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(otherOrganization.body.templates.map(({ name }) => name)).toContain(
      "Shared safety form",
    );
    expect(
      otherOrganization.body.templates.filter(
        ({ id }) => id === "nfpa70e_global",
      ),
    ).toHaveLength(1);
    expect(
      otherOrganization.body.templates.map(({ name }) => name),
    ).not.toContain("Private form");

    const deniedUpdate = await jsonRequest(
      fixture,
      `/templates/${global.body.template.id}`,
      "PUT",
      {
        definition: global.body.template.definition,
        expectedCurrentVersion: 1,
        name: "Organization safety form",
      },
    );
    expect(deniedUpdate.response.status).toBe(403);

    const organizationCopy = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${global.body.template.id}/copies`,
      "POST",
      {
        definition: global.body.template.definition,
        expectedCurrentVersion: 1,
        name: "Organization safety form",
      },
    );
    expect(organizationCopy.response.status).toBe(201);
    expect(organizationCopy.body.template).toMatchObject({
      currentVersion: 1,
      name: "Organization safety form",
      scope: "organization",
      version: 1,
    });
    expect(organizationCopy.body.template.id).not.toBe(global.body.template.id);

    const unchangedGlobal = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${global.body.template.id}`,
      "GET",
    );
    expect(unchangedGlobal.body.template).toMatchObject({
      currentVersion: 1,
      name: "Shared safety form",
      scope: "global",
      version: 1,
    });

    const adminUpdate = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${global.body.template.id}`,
      "PUT",
      {
        definition: global.body.template.definition,
        expectedCurrentVersion: 1,
        name: "Shared safety form v2",
      },
      { role: "admin" },
    );
    expect(adminUpdate.body.template).toMatchObject({
      currentVersion: 2,
      name: "Shared safety form v2",
      scope: "global",
      version: 2,
    });

    const privateRun = await jsonRequest(
      fixture,
      `/templates/${local.body.template.id}/runs`,
      "POST",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(privateRun.response.status).toBe(404);

    const copiedRun = await jsonRequest(
      fixture,
      `/templates/${organizationCopy.body.template.id}/runs`,
      "POST",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(copiedRun.response.status).toBe(404);

    const globalRun = await jsonRequest<RunResponse>(
      fixture,
      `/templates/${global.body.template.id}/runs`,
      "POST",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(globalRun.response.status).toBe(201);
    const globalRunDetail = await jsonRequest(
      fixture,
      `/runs/${globalRun.body.auditId}`,
      "GET",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(globalRunDetail.body).toMatchObject({
      audit: {
        templateId: global.body.template.id,
        templateName: "Shared safety form v2",
        templateVersion: 2,
      },
    });
  });

  it("consolidates organization starters into one global template", async () => {
    const database = await createLegacyDatabase();
    database.exec("PRAGMA foreign_keys = ON");
    await applyMigration(database, "0022_version_audit_templates.sql");
    const definition = JSON.stringify({ sections: [], version: 1 });
    const insertFamily = database.query(
      `INSERT INTO audit_template_families
       (id, scope, organization_id, current_version, created_by, created_at,
        updated_at)
       VALUES (?, 'organization', ?, 1, ?, ?, ?)`,
    );
    const insertVersion = database.query(
      `INSERT INTO audit_template_versions
       (id, template_id, version, name, description, definition, status,
        created_by, created_at)
       VALUES (?, ?, 1, 'NFPA 70E readiness checklist', '', ?, 'published',
        ?, ?)`,
    );
    for (const [templateId, organizationId, userId] of [
      ["nfpa70e_org_user-1", "org_user-1", "user-1"],
      ["nfpa70e_org_user-2", "org_user-2", "user-2"],
    ] as const) {
      insertFamily.run(
        templateId,
        organizationId,
        userId,
        "2026-08-20T12:00:00.000Z",
        "2026-08-20T12:00:00.000Z",
      );
      insertVersion.run(
        `${templateId}:v1`,
        templateId,
        definition,
        userId,
        "2026-08-20T12:00:00.000Z",
      );
    }
    database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_id, template_family_id,
          template_version_id, template_version, template_name, definition,
          responses, status, started_by, created_at, updated_at)
         VALUES ('starter-run', 'org_user-1', NULL, 'nfpa70e_org_user-1',
          'nfpa70e_org_user-1:v1', 1, 'NFPA 70E readiness checklist', ?, '{}',
          'in_progress', 'user-1', ?, ?)`,
      )
      .run(definition, "2026-08-21T12:00:00.000Z", "2026-08-21T12:00:00.000Z");

    await applyMigration(database, "0023_make_nfpa70e_template_global.sql");

    expect(
      database
        .query(
          `SELECT id, scope, organization_id
           FROM audit_template_families
           WHERE id GLOB 'nfpa70e_*'`,
        )
        .all(),
    ).toEqual([
      {
        id: "nfpa70e_global",
        organization_id: null,
        scope: "global",
      },
    ]);
    expect(
      database
        .query(
          `SELECT template_family_id, template_version_id, template_version
           FROM audits WHERE id = 'starter-run'`,
        )
        .get(),
    ).toEqual({
      template_family_id: "nfpa70e_global",
      template_version: 1,
      template_version_id: "nfpa70e_global:v1",
    });
  });
});

async function createFixture() {
  const database = await createLegacyDatabase();
  await applyMigration(database, "0022_version_audit_templates.sql");
  await applyMigration(database, "0024_create_audit_issue_images.sql");
  await applyMigration(database, "0025_classify_objects.sql");
  await applyMigration(database, "0026_track_object_deletion.sql");
  const stored = new Map<string, Uint8Array>();
  const databaseControl = {
    failNextImageInsert: false,
    failNextPendingUpdate: false,
  };
  const storageControl = { failNextDelete: false };
  const bindings = bindingsFor(
    database,
    stored,
    storageControl,
    databaseControl,
  );
  const app = testApp();
  return {
    app,
    bindings,
    database,
    databaseControl,
    storageControl,
    stored,
  };
}

async function createLegacyDatabase() {
  const database = new Database(":memory:");
  await applyMigration(database, "0001_create_objects.sql");
  await applyMigration(database, "0003_create_auth.sql");
  const insertUser = database.query(
    `INSERT INTO user
     (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [id, name, email] of [
    ["user-1", "Example Person", "person@example.com"],
    ["user-2", "Second Person", "second@example.com"],
  ] as const) {
    insertUser.run(
      id,
      name,
      email,
      false,
      "2026-08-18T12:00:00.000Z",
      "2026-08-18T12:00:00.000Z",
      "user",
      false,
    );
  }
  await applyMigration(database, "0004_create_organizations.sql");
  await applyMigration(database, "0005_create_audits.sql");
  await applyMigration(database, "0006_scope_objects_to_organizations.sql");
  return database;
}

function testApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    const organizationId =
      context.req.header("x-test-organization-id") ?? "org_user-1";
    const userId = context.req.header("x-test-user-id") ?? "user-1";
    context.set("organizationId", organizationId);
    context.set("organizationRole", "owner");
    context.set("authSession", {
      user: {
        defaultOrganizationId: organizationId,
        id: userId,
        role: context.req.header("x-test-role") ?? "user",
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
  identity?: TestIdentity,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (identity?.organizationId) {
    headers["x-test-organization-id"] = identity.organizationId;
  }
  if (identity?.role) headers["x-test-role"] = identity.role;
  if (identity?.userId) headers["x-test-user-id"] = identity.userId;
  const init: RequestInit = {
    headers,
    method,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fixture.app.request(path, init, fixture.bindings);
  return { body: (await response.json()) as T, response };
}

function bindingsFor(
  database: Database,
  stored: Map<string, Uint8Array> = new Map(),
  storageControl = { failNextDelete: false },
  databaseControl = {
    failNextImageInsert: false,
    failNextPendingUpdate: false,
  },
): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database, databaseControl),
    EMAIL: {} as SendEmail,
    IMAGES: imagesFor(),
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.com",
    STORAGE: storageFor(stored, storageControl),
  };
}

function storageFor(
  stored: Map<string, Uint8Array>,
  control: { failNextDelete: boolean },
) {
  return {
    delete: async (key: string) => {
      if (control.failNextDelete) {
        control.failNextDelete = false;
        throw new Error("Transient R2 delete failure");
      }
      return stored.delete(key);
    },
    get: async (key: string) => {
      const content = stored.get(key);
      if (!content) return null;
      return {
        body: new Blob([content]).stream(),
        httpEtag: '"test-etag"',
      };
    },
    put: async (key: string, value: ArrayBuffer) => {
      stored.set(key, new Uint8Array(value));
    },
  } as unknown as R2Bucket;
}

function toD1(
  database: Database,
  control = { failNextImageInsert: false, failNextPendingUpdate: false },
) {
  let batchTail: Promise<void> = Promise.resolve();
  return {
    batch: (statements: D1PreparedStatement[]) => {
      const execution = batchTail.then(() => {
        database.exec("BEGIN");
        try {
          const results = statements.map((statement) =>
            (
              statement as D1PreparedStatement & {
                runSync: () => D1Result;
              }
            ).runSync(),
          );
          database.exec("COMMIT");
          return results;
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
      });
      batchTail = execution.then(
        () => undefined,
        () => undefined,
      );
      return execution;
    },
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const runSync = () => {
        if (
          control.failNextImageInsert &&
          query.includes("INSERT INTO audit_issue_images")
        ) {
          control.failNextImageInsert = false;
          throw new Error("Transient D1 image insert failure");
        }
        if (
          control.failNextPendingUpdate &&
          query.includes("UPDATE objects SET deletion_pending = 1")
        ) {
          control.failNextPendingUpdate = false;
          throw new Error("Transient D1 update failure");
        }
        const result = database.query(query).run(...values);
        return { meta: { changes: result.changes }, success: true };
      };
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
        run: async () => runSync(),
        runSync,
      };
      return statement;
    },
  } as unknown as D1Database;
}

function pngForm(filename: string) {
  const form = new FormData();
  form.set("file", new File([pngBytes()], filename, { type: "image/png" }));
  return form;
}

function pngBytes() {
  return Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
}

function imagesFor(dimensions: { height?: number; width?: number } = {}) {
  const readValidPng = async (stream: ReadableStream<Uint8Array>) => {
    const actual = new Uint8Array(await new Response(stream).arrayBuffer());
    const expected = pngBytes();
    if (
      actual.length !== expected.length ||
      !actual.every((byte, index) => byte === expected[index])
    ) {
      throw new Error("Invalid test image");
    }
    return actual;
  };
  return {
    info: async (stream: ReadableStream<Uint8Array>) => {
      const actual = await readValidPng(stream);
      return {
        fileSize: actual.length,
        format: "image/png",
        height: dimensions.height ?? 1,
        width: dimensions.width ?? 1,
      };
    },
    input: (stream: ReadableStream<Uint8Array>) => {
      const actual = readValidPng(stream);
      return {
        output: async (options: ImageOutputOptions) => {
          if (options.anim !== false || options.format !== "image/png") {
            throw new Error("Test images must be normalized without animation");
          }
          const normalized = await actual;
          return {
            contentType: () => "image/png",
            image: () => new Blob([normalized]).stream(),
          };
        },
      };
    },
  } as unknown as ImagesBinding;
}

async function applyMigration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}
