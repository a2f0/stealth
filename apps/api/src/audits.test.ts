import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuditDefinition } from "./auditDefinition";
import {
  ImageUploadReadTimeoutError,
  purgePendingAuditIssueImages,
  readBodyWithLimit,
} from "./auditIssueImages";
import { audits } from "./audits";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { purgeDeletedObjects } from "./deletedObjectCleanup";
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
    savedBy: { email: string; id: string; name: string };
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

interface RunListResponse {
  audits: Array<{ id: string }>;
  nextCursor: string | null;
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
    const exactBytes = await readBodyWithLimit(exact, 3);
    expect(exactBytes).not.toBeNull();
    expect(new Uint8Array(exactBytes ?? [])).toEqual(
      Uint8Array.from([1, 2, 3]),
    );

    let timedOutStreamCancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      cancel: () => {
        timedOutStreamCancelled = true;
      },
    });
    await expect(readBodyWithLimit(stalled, 7, 5)).rejects.toBeInstanceOf(
      ImageUploadReadTimeoutError,
    );
    expect(timedOutStreamCancelled).toBe(true);
  });

  it("does not wait for a stalled request-stream cancellation", async () => {
    const neverCancels = () => new Promise<void>(() => undefined);
    const oversized = new ReadableStream<Uint8Array>({
      cancel: neverCancels,
      start(controller) {
        controller.enqueue(new Uint8Array(8));
      },
    });
    const oversizedOutcome = await Promise.race([
      readBodyWithLimit(oversized, 7),
      new Promise<"stalled">((resolve) =>
        setTimeout(() => resolve("stalled"), 50),
      ),
    ]);
    expect(oversizedOutcome).toBeNull();

    const timedOut = new ReadableStream<Uint8Array>({
      cancel: neverCancels,
    });
    const timeoutOutcome = await Promise.race([
      readBodyWithLimit(timedOut, 7, 5).catch((cause: unknown) => cause),
      new Promise<"stalled">((resolve) =>
        setTimeout(() => resolve("stalled"), 50),
      ),
    ]);
    expect(timeoutOutcome).toBeInstanceOf(ImageUploadReadTimeoutError);
  });

  it("paginates every retained audit run with a stable cursor", async () => {
    const fixture = await createFixture();
    const insert = fixture.database.query(
      `INSERT INTO audits
       (id, organization_id, template_name, definition, responses, status,
        started_by, created_at, updated_at)
       VALUES (?, 'org_user-1', 'History test', ?, '{}', 'completed',
               'user-1', ?, ?)`,
    );
    const definition = JSON.stringify({
      sections: [{ id: "section", items: [], title: "History" }],
      version: 1,
    });
    for (let index = 0; index < 105; index += 1) {
      const createdAt = new Date(
        Date.UTC(2026, 7, 1, 0, 0, index),
      ).toISOString();
      insert.run(
        `history-${index.toString().padStart(3, "0")}`,
        definition,
        createdAt,
        createdAt,
      );
    }

    const first = await jsonRequest<RunListResponse>(fixture, "/runs", "GET");
    expect(first.response.status).toBe(200);
    expect(first.body.audits).toHaveLength(100);
    expect(first.body.nextCursor).toBeString();

    const second = await jsonRequest<RunListResponse>(
      fixture,
      `/runs?cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
      "GET",
    );
    expect(second.response.status).toBe(200);
    expect(second.body.audits).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.audits, ...second.body.audits].map(
      ({ id }) => id,
    );
    expect(ids).toHaveLength(105);
    expect(new Set(ids)).toHaveLength(105);
    expect(ids[0]).toBe("history-104");
    expect(ids.at(-1)).toBe("history-000");

    const invalid = await jsonRequest(fixture, "/runs?cursor=not-valid", "GET");
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toEqual({ error: "Invalid audit cursor." });
  });

  it("reports an audit removed during an update as missing", async () => {
    const fixture = await createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_name, definition, responses, status,
          started_by, created_at, updated_at)
         VALUES ('update-race', 'org_user-1', 'Race test', ?, '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(
        JSON.stringify({
          sections: [{ id: "section", items: [], title: "Race" }],
          version: 1,
        }),
        now,
        now,
      );
    fixture.databaseControl.deleteAuditBeforeRunUpdate = true;

    const updated = await jsonRequest(fixture, "/runs/update-race", "PATCH", {
      responses: {},
      status: "in_progress",
    });

    expect(updated.response.status).toBe(404);
    expect(updated.body).toEqual({ error: "Audit not found." });
  });

  it("normalizes and stores every supported issue image format", async () => {
    const fixture = await createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_name, definition, responses, status,
          started_by, created_at, updated_at)
         VALUES ('format-audit', 'org_user-1', 'Format test', '{}', '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.database
      .query(
        `INSERT INTO audit_issues
         (id, organization_id, audit_id, item_id, title, created_by,
          created_at, updated_at)
         VALUES ('format-issue', 'org_user-1', 'format-audit', 'item',
                 'Format test issue', 'user-1', ?, ?)`,
      )
      .run(now, now);

    const formats = [
      {
        bytes: pngBytes(),
        contentType: "image/png",
        extension: "png",
      },
      {
        bytes: jpegBytes(),
        contentType: "image/jpeg",
        extension: "jpg",
      },
      {
        bytes: gifBytes(),
        contentType: "image/gif",
        extension: "gif",
      },
      {
        bytes: webpBytes(),
        contentType: "image/webp",
        extension: "webp",
      },
    ] as const;

    for (const format of formats) {
      let outputOptions: ImageOutputOptions | undefined;
      fixture.bindings.IMAGES = imagesFor({
        expectedBytes: format.bytes,
        format: format.contentType,
        onOutput: (options) => {
          outputOptions = options;
        },
      });
      const uploaded = await fixture.app.request(
        `/issues/format-issue/images?filename=evidence.original`,
        imageUpload(format.bytes, format.contentType),
        fixture.bindings,
      );
      expect(uploaded.status).toBe(201);
      const body = (await uploaded.json()) as IssueImageResponse;
      expect(body.image).toMatchObject({
        contentType: format.contentType,
        filename: `evidence.${format.extension}`,
      });
      expect(outputOptions).toEqual({
        anim: false,
        format: format.contentType,
      });

      const object = fixture.database
        .query(
          `SELECT object_key, content_type, filename, deletion_pending
           FROM objects WHERE filename = ?`,
        )
        .get(`evidence.${format.extension}`) as {
        content_type: string;
        deletion_pending: number;
        filename: string;
        object_key: string;
      };
      expect(object).toMatchObject({
        content_type: format.contentType,
        deletion_pending: 0,
        filename: `evidence.${format.extension}`,
      });
      expect(fixture.stored.get(object.object_key)).toEqual(format.bytes);

      const storedImage = await fixture.app.request(
        `/issues/format-issue/images/${body.image.id}`,
        undefined,
        fixture.bindings,
      );
      expect(storedImage.status).toBe(200);
      expect(storedImage.headers.get("content-type")).toBe(format.contentType);
    }

    const emojiBytes = pngBytes();
    fixture.bindings.IMAGES = imagesFor({
      expectedBytes: emojiBytes,
      format: "image/png",
    });
    const longUnicodeName = `${"😀".repeat(255)}.original`;
    const unicodeUpload = await fixture.app.request(
      `/issues/format-issue/images?${new URLSearchParams({
        filename: longUnicodeName,
      })}`,
      imageUpload(emojiBytes, "image/png"),
      fixture.bindings,
    );
    expect(unicodeUpload.status).toBe(201);
    const unicodeBody = (await unicodeUpload.json()) as IssueImageResponse;
    expect(unicodeBody.image.filename).toBe(`${"😀".repeat(62)}.png`);
    expect(
      new TextEncoder().encode(unicodeBody.image.filename).byteLength,
    ).toBe(252);
    expect(() => encodeURIComponent(unicodeBody.image.filename)).not.toThrow();
  });

  it("bounds concurrent maximum-size image upload memory", async () => {
    const fixture = await createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    for (const [suffix, organizationId, userId] of [
      ["one", "org_user-1", "user-1"],
      ["two", "org_user-2", "user-2"],
    ] as const) {
      fixture.database
        .query(
          `INSERT INTO audits
           (id, organization_id, template_name, definition, responses, status,
            started_by, created_at, updated_at)
           VALUES (?, ?, 'Memory test', '{}', '{}', 'in_progress', ?, ?, ?)`,
        )
        .run(`memory-audit-${suffix}`, organizationId, userId, now, now);
      fixture.database
        .query(
          `INSERT INTO audit_issues
           (id, organization_id, audit_id, item_id, title, created_by,
            created_at, updated_at)
           VALUES (?, ?, ?, 'item', 'Memory test issue', ?, ?, ?)`,
        )
        .run(
          `memory-issue-${suffix}`,
          organizationId,
          `memory-audit-${suffix}`,
          userId,
          now,
          now,
        );
    }
    const maximumImage = new Uint8Array(10 * 1024 * 1024);
    maximumImage.set(pngBytes());
    let processing = 0;
    let releaseProcessing: (() => void) | undefined;
    const processingGate = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    fixture.bindings.IMAGES = imagesFor({
      expectedBytes: maximumImage,
      normalizedBytes: pngBytes(),
      onInfo: async () => {
        processing += 1;
        if (processing === 2) queueMicrotask(() => releaseProcessing?.());
        await processingGate;
      },
    });

    const uploads = await Promise.all([
      fixture.app.request(
        "/issues/memory-issue-one/images?filename=one-a.png",
        imageUpload(maximumImage),
        fixture.bindings,
      ),
      fixture.app.request(
        "/issues/memory-issue-one/images?filename=one-b.png",
        imageUpload(maximumImage),
        fixture.bindings,
      ),
      fixture.app.request(
        "/issues/memory-issue-two/images?filename=two.png",
        imageUpload(maximumImage, "image/png", {
          "x-test-organization-id": "org_user-2",
          "x-test-user-id": "user-2",
        }),
        fixture.bindings,
      ),
    ]);

    expect(uploads.filter(({ status }) => status === 201)).toHaveLength(2);
    expect(uploads.filter(({ status }) => status === 429)).toHaveLength(1);
    expect(uploads[2]?.status).toBe(201);
    expect(
      uploads.slice(0, 2).filter(({ status }) => status === 201),
    ).toHaveLength(1);
    expect(
      uploads.slice(0, 2).filter(({ status }) => status === 429),
    ).toHaveLength(1);
    expect(processing).toBe(2);
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
    expect(starterBody.templates).toHaveLength(2);
    const nfpaStarter = starterBody.templates.find(
      ({ id }) => id === "nfpa70e_global",
    );
    expect(nfpaStarter).toMatchObject({
      id: "nfpa70e_global",
      name: "NFPA 70E readiness checklist",
      scope: "global",
    });
    expect(nfpaStarter?.definition.sections).toHaveLength(6);
    const residentialStarter = starterBody.templates.find(
      ({ id }) => id === "us_residential_core_global",
    );
    expect(residentialStarter).toMatchObject({
      name: "U.S. residential construction — comprehensive baseline",
      scope: "global",
    });
    expect(residentialStarter?.definition.sections.length).toBeGreaterThan(15);
    expect(
      residentialStarter?.definition.sections.reduce(
        (count, section) => count + section.items.length,
        0,
      ),
    ).toBeGreaterThanOrEqual(225);

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

    fixture.database
      .query(
        `INSERT INTO member
         (id, organizationId, userId, role, createdAt)
         VALUES ('member-user-2-org-1', 'org_user-1', 'user-2', 'member', ?)`,
      )
      .run("2026-08-25T12:00:00.000Z");
    fixture.databaseControl.deleteAssigneeBeforeIssueUpdate = true;
    const removedDuringAssignment = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: "user-2" },
    );
    expect(removedDuringAssignment.response.status).toBe(400);
    expect(
      fixture.database
        .query(`SELECT assigned_to FROM audit_issues WHERE id = ?`)
        .get(issue.body.issueId),
    ).toEqual({ assigned_to: "user-1" });

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

    const invalidImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=fake.png`,
      imageUpload("not an image"),
      fixture.bindings,
    );
    expect(invalidImage.status).toBe(400);
    expect(fixture.stored.size).toBe(0);

    const truncatedImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=truncated.png`,
      imageUpload(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
      fixture.bindings,
    );
    expect(truncatedImage.status).toBe(400);
    expect(fixture.stored.size).toBe(0);

    fixture.bindings.IMAGES = imagesFor({ width: 12_001 });
    const oversizedDimensions = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=too-wide.png`,
      imageUpload(pngBytes(), "application/octet-stream"),
      fixture.bindings,
    );
    expect(oversizedDimensions.status).toBe(400);
    expect(fixture.stored.size).toBe(0);

    fixture.bindings.IMAGES = imagesFor({
      normalizedBytes: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    const oversizedNormalizedImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=oversized-output.png`,
      imageUpload(pngBytes()),
      fixture.bindings,
    );
    expect(oversizedNormalizedImage.status).toBe(413);
    expect(fixture.stored.size).toBe(0);
    expect(
      fixture.database
        .query(`SELECT COUNT(*) AS count FROM audit_issue_images`)
        .get(),
    ).toEqual({ count: 0 });
    fixture.bindings.IMAGES = imagesFor();

    const uploaded = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=electrical-panel.jpg`,
      imageUpload(pngBytes(), "image/jpeg"),
      fixture.bindings,
    );
    expect(uploaded.status).toBe(201);
    const uploadedBody = (await uploaded.json()) as IssueImageResponse;
    expect(uploadedBody.image).toMatchObject({
      contentType: "image/png",
      filename: "electrical-panel.png",
    });

    fixture.databaseControl.commitThenThrowImageActivation = true;
    fixture.databaseControl.failNextPendingUpdate = true;
    const committedWithoutResponse = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=committed-without-response.png`,
      imageUpload(pngBytes()),
      fixture.bindings,
    );
    expect(committedWithoutResponse.status).toBe(201);
    const committedWithoutResponseBody =
      (await committedWithoutResponse.json()) as IssueImageResponse;
    expect(
      fixture.database
        .query(
          `SELECT deletion_pending FROM objects
           WHERE filename = 'committed-without-response.png'`,
        )
        .get(),
    ).toEqual({ deletion_pending: 0 });
    expect(fixture.stored.size).toBe(2);
    const retainedCommittedImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${committedWithoutResponseBody.image.id}`,
      undefined,
      fixture.bindings,
    );
    expect(retainedCommittedImage.status).toBe(200);
    expect(fixture.databaseControl.commitThenThrowImageActivation).toBe(false);
    expect(fixture.databaseControl.failNextPendingUpdate).toBe(true);
    fixture.databaseControl.failNextPendingUpdate = false;
    const deletedCommittedImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${committedWithoutResponseBody.image.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deletedCommittedImage.status).toBe(204);
    expect(fixture.stored.size).toBe(1);

    fixture.storageControl.beforeNextPut = async () => {
      fixture.database
        .query(
          `UPDATE objects SET created_at = '2000-01-01T00:00:00.000Z'
           WHERE filename = 'lease-protected.png'`,
        )
        .run();
      expect(await purgePendingAuditIssueImages(fixture.bindings)).toBe(0);
      expect(
        fixture.database
          .query(
            `SELECT cleanup_token, upload_token,
                    datetime(upload_lease_expires_at) > datetime('now') AS leased
             FROM objects WHERE filename = 'lease-protected.png'`,
          )
          .get(),
      ).toEqual({
        cleanup_token: null,
        leased: 1,
        upload_token: expect.any(String),
      });
    };
    const leaseProtectedUpload = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=lease-protected.png`,
      imageUpload(pngBytes()),
      fixture.bindings,
    );
    expect(leaseProtectedUpload.status).toBe(201);
    const leaseProtectedBody =
      (await leaseProtectedUpload.json()) as IssueImageResponse;
    const deletedLeaseProtectedImage = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${leaseProtectedBody.image.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deletedLeaseProtectedImage.status).toBe(204);
    expect(fixture.stored.size).toBe(1);

    fixture.storageControl.beforeNextPut = async () => {
      fixture.database
        .query(
          `UPDATE objects
           SET created_at = '2000-01-01T00:00:00.000Z',
               upload_lease_expires_at = '2000-01-01T00:00:00.000Z'
           WHERE filename = 'expired-mid-write.png'`,
        )
        .run();
      expect(
        await purgePendingAuditIssueImages(
          fixture.bindings,
          "9999-12-31T23:59:59.999Z",
          "9999-12-31T23:59:59.999Z",
        ),
      ).toBe(1);
    };
    const expiredMidWriteUpload = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=expired-mid-write.png`,
      imageUpload(pngBytes()),
      fixture.bindings,
    );
    expect(expiredMidWriteUpload.status).toBe(500);
    expect(fixture.stored.size).toBe(1);
    expect(
      fixture.database
        .query(
          `SELECT id FROM objects WHERE filename = 'expired-mid-write.png'`,
        )
        .get(),
    ).toBeNull();

    fixture.databaseControl.failNextImageActivation = true;
    fixture.storageControl.failNextDelete = true;
    const failedUploadCleanup = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=cleanup-retry.png`,
      imageUpload(pngBytes()),
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
    fixture.databaseControl.activateBeforeCleanupClaim = true;
    expect(
      await purgePendingAuditIssueImages(
        fixture.bindings,
        "9999-12-31T23:59:59.999Z",
      ),
    ).toBe(0);
    expect(fixture.stored.size).toBe(2);
    expect(
      fixture.database
        .query(
          `SELECT cleanup_token, deletion_pending FROM objects
           WHERE filename = 'cleanup-retry.png'`,
        )
        .get(),
    ).toEqual({ cleanup_token: null, deletion_pending: 0 });
    fixture.database
      .query(
        `UPDATE objects SET deletion_pending = 1
         WHERE filename = 'cleanup-retry.png'`,
      )
      .run();
    expect(
      await purgePendingAuditIssueImages(
        fixture.bindings,
        "9999-12-31T23:59:59.999Z",
      ),
    ).toBe(1);
    expect(fixture.stored.size).toBe(1);

    let processedConcurrentUploads = 0;
    fixture.bindings.IMAGES = imagesFor({
      onInfo: () => {
        processedConcurrentUploads += 1;
      },
    });
    const concurrentUploads = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fixture.app.request(
          `/issues/${issue.body.issueId}/images?filename=concurrent-${index}.png`,
          imageUpload(pngBytes()),
          fixture.bindings,
        ),
      ),
    );
    expect(
      concurrentUploads.filter(({ status }) => status === 201),
    ).toHaveLength(1);
    expect(
      concurrentUploads.filter(({ status }) => status === 429),
    ).toHaveLength(9);
    expect(
      concurrentUploads
        .filter(({ status }) => status === 429)
        .every((response) => response.headers.get("retry-after") === "1"),
    ).toBe(true);
    const retriedUploads: Response[] = [];
    for (let index = 0; index < 9; index += 1) {
      retriedUploads.push(
        await fixture.app.request(
          `/issues/${issue.body.issueId}/images?filename=retry-${index}.png`,
          imageUpload(pngBytes()),
          fixture.bindings,
        ),
      );
    }
    expect(retriedUploads.filter(({ status }) => status === 201)).toHaveLength(
      8,
    );
    expect(retriedUploads.filter(({ status }) => status === 409)).toHaveLength(
      1,
    );
    expect(processedConcurrentUploads).toBe(9);
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

    const rejectedBeforeProcessing = await fixture.app.request(
      `/issues/${issue.body.issueId}/images?filename=invalid.png`,
      imageUpload("not an image"),
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

    let thumbnailTransform: Record<string, unknown> | undefined;
    fixture.bindings.IMAGES = imagesFor({
      onTransform: (options) => {
        thumbnailTransform = options;
      },
    });
    const thumbnail = await fixture.app.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}?variant=thumbnail`,
      undefined,
      fixture.bindings,
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("cache-control")).toBe("no-store");
    expect(thumbnail.headers.get("content-type")).toBe("image/webp");
    expect(thumbnailTransform).toEqual({
      fit: "scale-down",
      height: 480,
      width: 480,
    });

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
      .query(`SELECT id FROM objects WHERE filename = 'electrical-panel.png'`)
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
      `/issues/${issue.body.issueId}/images?filename=replacement.png`,
      imageUpload(pngBytes()),
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

  it("tombstones image objects when an issue is cascade-deleted", async () => {
    const fixture = await createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    const definition = JSON.stringify({ sections: [], version: 1 });
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_id, template_name, definition,
          responses, status, started_by, created_at, updated_at)
         VALUES ('cascade-audit', 'org_user-1', NULL, 'Cascade audit', ?, '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(definition, now, now);
    fixture.database
      .query(
        `INSERT INTO audit_issues
         (id, organization_id, audit_id, item_id, title, created_by,
          created_at, updated_at)
         VALUES ('cascade-issue', 'org_user-1', 'cascade-audit', 'item-1',
                 'Cascade issue', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.database
      .query(
        `INSERT INTO objects
         (id, organization_id, object_key, filename, content_type, size,
          created_at, kind, deletion_pending)
         VALUES ('cascade-object', 'org_user-1', 'cascade/image', 'image.png',
                 'image/png', 3, ?, 'audit_issue_image', 0)`,
      )
      .run(now);
    fixture.database
      .query(
        `INSERT INTO audit_issue_images
         (id, issue_id, object_id, uploaded_by, slot, created_at)
         VALUES ('cascade-image', 'cascade-issue', 'cascade-object', 'user-1',
                 1, ?)`,
      )
      .run(now);
    fixture.stored.set("cascade/image", Uint8Array.from([1, 2, 3]));
    fixture.database.exec("PRAGMA foreign_keys = ON");

    fixture.database
      .query(`DELETE FROM audit_issues WHERE id = 'cascade-issue'`)
      .run();

    expect(
      fixture.database
        .query(`SELECT id FROM audit_issue_images WHERE id = 'cascade-image'`)
        .get(),
    ).toBeNull();
    expect(
      fixture.database
        .query(
          `SELECT deletion_pending, cleanup_token, upload_token
           FROM objects WHERE id = 'cascade-object'`,
        )
        .get(),
    ).toEqual({
      cleanup_token: null,
      deletion_pending: 1,
      upload_token: null,
    });
    expect(await purgePendingAuditIssueImages(fixture.bindings, now)).toBe(1);
    expect(fixture.stored.size).toBe(0);
    expect(
      fixture.database
        .query(`SELECT id FROM objects WHERE id = 'cascade-object'`)
        .get(),
    ).toBeNull();
    expect(
      fixture.database
        .query(
          `SELECT id FROM deleted_object_cleanup WHERE id = 'cascade-object'`,
        )
        .get(),
    ).toBeNull();

    fixture.database
      .query(
        `INSERT INTO audit_issues
         (id, organization_id, audit_id, item_id, title, created_by,
          created_at, updated_at)
         VALUES ('upload-race-issue', 'org_user-1', 'cascade-audit', 'item-2',
                 'Upload race issue', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.storageControl.beforeNextPut = async () => {
      fixture.database
        .query(`DELETE FROM audit_issues WHERE id = 'upload-race-issue'`)
        .run();
    };

    const racedUpload = await fixture.app.request(
      "/issues/upload-race-issue/images?filename=race.png",
      imageUpload(pngBytes()),
      fixture.bindings,
    );

    expect(racedUpload.status).toBe(500);
    expect(fixture.stored.size).toBe(0);
    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count FROM objects
           WHERE kind = 'audit_issue_image'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(`SELECT COUNT(*) AS count FROM audit_issue_images`)
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(`SELECT COUNT(*) AS count FROM deleted_object_cleanup`)
        .get(),
    ).toEqual({ count: 0 });
  });

  it("retains R2 cleanup after an organization is hard-deleted", async () => {
    const fixture = await createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_name, definition, responses, status,
          started_by, created_at, updated_at)
         VALUES ('purged-audit', 'org_user-1', 'Purged audit', '{}', '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.database
      .query(
        `INSERT INTO audit_issues
         (id, organization_id, audit_id, item_id, title, created_by,
          created_at, updated_at)
         VALUES ('purged-issue', 'org_user-1', 'purged-audit', 'item-1',
                 'Purged issue', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.database
      .query(
        `INSERT INTO objects
         (id, organization_id, object_key, filename, content_type, size,
          created_at, kind, deletion_pending)
         VALUES ('purged-object', 'org_user-1', 'purged/image', 'image.png',
                 'image/png', 3, ?, 'audit_issue_image', 0)`,
      )
      .run(now);
    fixture.database
      .query(
        `INSERT INTO audit_issue_images
         (id, issue_id, object_id, uploaded_by, slot, created_at)
         VALUES ('purged-image', 'purged-issue', 'purged-object', 'user-1',
                 1, ?)`,
      )
      .run(now);
    fixture.stored.set("purged/image", Uint8Array.from([1, 2, 3]));
    fixture.database.exec("PRAGMA foreign_keys = ON");

    fixture.database
      .query(`DELETE FROM organization WHERE id = 'org_user-1'`)
      .run();

    expect(
      fixture.database
        .query(`SELECT id FROM objects WHERE id = 'purged-object'`)
        .get(),
    ).toBeNull();
    expect(
      fixture.database
        .query(
          `SELECT id, organization_id, object_key FROM deleted_object_cleanup
           WHERE id = 'purged-object'`,
        )
        .get(),
    ).toEqual({
      id: "purged-object",
      object_key: "purged/image",
      organization_id: "org_user-1",
    });
    expect(fixture.stored.has("purged/image")).toBe(true);

    fixture.storageControl.failNextDelete = true;
    const eligibleCutoffs = {
      abandonedClaimedBefore: "9999-12-31T23:59:59.999Z",
      deletedBefore: "9999-12-31T23:59:59.999Z",
    };
    await expect(
      purgeDeletedObjects(fixture.bindings, eligibleCutoffs),
    ).rejects.toThrow("Transient R2 delete failure");
    expect(
      fixture.database
        .query(
          `SELECT cleanup_token FROM deleted_object_cleanup
           WHERE id = 'purged-object'`,
        )
        .get(),
    ).toEqual({ cleanup_token: expect.any(String) });
    expect(fixture.stored.has("purged/image")).toBe(true);

    expect(await purgeDeletedObjects(fixture.bindings, eligibleCutoffs)).toBe(
      1,
    );
    expect(fixture.stored.has("purged/image")).toBe(false);
    expect(
      fixture.database
        .query(
          `SELECT id FROM deleted_object_cleanup WHERE id = 'purged-object'`,
        )
        .get(),
    ).toBeNull();
  });

  it("waits out in-flight uploads before purging deleted organizations", async () => {
    const fixture = await createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO objects
         (id, organization_id, object_key, filename, content_type, size,
          created_at, kind, deletion_pending, upload_token,
          upload_lease_expires_at)
         VALUES ('raced-object', 'org_user-1', 'raced/image', 'image.png',
                 'image/png', 0, ?, 'audit_issue_image', 1, 'upload-token',
                 '9999-12-31T23:59:59.999Z')`,
      )
      .run(now);
    fixture.database.exec("PRAGMA foreign_keys = ON");

    fixture.database
      .query(`DELETE FROM organization WHERE id = 'org_user-1'`)
      .run();

    expect(await purgeDeletedObjects(fixture.bindings)).toBe(0);
    expect(
      fixture.database
        .query(
          `SELECT id FROM deleted_object_cleanup WHERE id = 'raced-object'`,
        )
        .get(),
    ).toEqual({ id: "raced-object" });

    // Model the request finishing its R2 write and crashing before activation.
    fixture.stored.set("raced/image", Uint8Array.from([1, 2, 3]));
    expect(
      await purgeDeletedObjects(fixture.bindings, {
        abandonedClaimedBefore: "9999-12-31T23:59:59.999Z",
        deletedBefore: "9999-12-31T23:59:59.999Z",
      }),
    ).toBe(1);
    expect(fixture.stored.has("raced/image")).toBe(false);
    expect(
      fixture.database
        .query(
          `SELECT id FROM deleted_object_cleanup WHERE id = 'raced-object'`,
        )
        .get(),
    ).toBeNull();
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

  it("limits Free organizations to five form templates", async () => {
    const fixture = await createFixture();
    for (let index = 1; index <= 5; index += 1) {
      const created = await jsonRequest(fixture, "/templates", "POST", {
        name: `Free form ${index}`,
      });
      expect(created.response.status).toBe(201);
    }
    const limited = await jsonRequest(fixture, "/templates", "POST", {
      name: "Sixth free form",
    });
    expect(limited.response.status).toBe(409);
    expect(limited.body).toEqual({
      error:
        "The Free plan is limited to 5 form templates. Upgrade to Pro for unlimited forms.",
    });

    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_price_id, stripe_status, seat_quantity,
          stripe_event_created, updated_at)
         VALUES ('org_user-1', 'price_pro_test', 'active', 1, 1, ?)`,
      )
      .run(new Date().toISOString());
    const pro = await jsonRequest(fixture, "/templates", "POST", {
      name: "Sixth Pro form",
    });
    expect(pro.response.status).toBe(201);
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

  it("attributes built-in templates to a durable system actor", async () => {
    const fixture = await createFixture();
    const bookmarked = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates/us_residential_core_global",
      "GET",
    );
    expect(bookmarked.response.status).toBe(200);
    expect(bookmarked.body.template.name).toBe(
      "U.S. residential construction — comprehensive baseline",
    );

    const firstOrganization = await jsonRequest<TemplateListResponse>(
      fixture,
      "/templates",
      "GET",
    );
    expect(firstOrganization.response.status).toBe(200);

    const otherOrganization = await jsonRequest<TemplateListResponse>(
      fixture,
      "/templates",
      "GET",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    const builtIns = otherOrganization.body.templates.filter(({ id }) =>
      ["nfpa70e_global", "us_residential_core_global"].includes(id),
    );
    expect(builtIns).toHaveLength(2);
    for (const template of builtIns) {
      expect(template.savedBy).toEqual({
        email: "audit-library@system.invalid",
        id: "system:audit-library",
        name: "Stealth audit library",
      });
    }
    expect(JSON.stringify(otherOrganization.body)).not.toContain(
      "person@example.com",
    );

    expect(
      fixture.database.query("DELETE FROM user WHERE id = 'user-1'").run()
        .changes,
    ).toBe(1);
    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count
           FROM audit_template_families
           WHERE id IN ('nfpa70e_global', 'us_residential_core_global')`,
        )
        .get(),
    ).toEqual({ count: 2 });
  });

  it("seeds the audit actor despite a public email collision", async () => {
    const database = await createLegacyDatabase();
    await applyMigration(database, "0022_version_audit_templates.sql");
    database
      .query(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES ('collision-user', 'Collision User', ?, 1, ?, ?, 'user', 0)`,
      )
      .run(
        "audit-library@system.invalid",
        "2026-08-25T12:00:00.000Z",
        "2026-08-25T12:00:00.000Z",
      );

    await applyMigration(database, "0033_create_audit_library_actor.sql");

    expect(
      database
        .query("SELECT id, email FROM user WHERE id = 'collision-user'")
        .get(),
    ).toEqual({
      email: "audit-library@system.invalid",
      id: "collision-user",
    });
    const actor = database
      .query("SELECT email, name FROM user WHERE id = 'system:audit-library'")
      .get() as { email: string; name: string };
    expect(actor.name).toBe("Stealth audit library");
    expect(actor.email).toStartWith("audit-library+");
    expect(actor.email).toEndWith("@system.invalid");
    expect(actor.email).not.toBe("audit-library@system.invalid");
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
    await applyMigration(database, "0033_create_audit_library_actor.sql");

    expect(
      database
        .query(
          `SELECT id, scope, organization_id, created_by
           FROM audit_template_families
           WHERE id GLOB 'nfpa70e_*'`,
        )
        .all(),
    ).toEqual([
      {
        created_by: "system:audit-library",
        id: "nfpa70e_global",
        organization_id: null,
        scope: "global",
      },
    ]);
    expect(
      database
        .query(
          `SELECT created_by
           FROM audit_template_versions
           WHERE id = 'nfpa70e_global:v1'`,
        )
        .get(),
    ).toEqual({ created_by: "system:audit-library" });
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
  await applyMigration(database, "0027_claim_object_cleanup.sql");
  await applyMigration(database, "0028_lease_audit_image_uploads.sql");
  await applyMigration(database, "0029_tombstone_cascaded_audit_images.sql");
  await applyMigration(database, "0030_queue_deleted_objects.sql");
  await applyMigration(database, "0032_create_billing.sql");
  await applyMigration(database, "0033_create_audit_library_actor.sql");
  const stored = new Map<string, Uint8Array>();
  const databaseControl = {
    activateBeforeCleanupClaim: false,
    commitThenThrowImageActivation: false,
    deleteAuditBeforeRunUpdate: false,
    deleteAssigneeBeforeIssueUpdate: false,
    failNextImageActivation: false,
    failNextPendingUpdate: false,
  };
  const storageControl: {
    beforeNextPut?: () => Promise<void>;
    failNextDelete: boolean;
  } = { failNextDelete: false };
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
  storageControl: {
    beforeNextPut?: () => Promise<void>;
    failNextDelete: boolean;
  } = { failNextDelete: false },
  databaseControl = {
    activateBeforeCleanupClaim: false,
    commitThenThrowImageActivation: false,
    deleteAuditBeforeRunUpdate: false,
    deleteAssigneeBeforeIssueUpdate: false,
    failNextImageActivation: false,
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
    STRIPE_PRO_PRICE_ID: "price_pro_test",
    STORAGE: storageFor(stored, storageControl),
  };
}

function storageFor(
  stored: Map<string, Uint8Array>,
  control: {
    beforeNextPut?: () => Promise<void>;
    failNextDelete: boolean;
  },
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
    put: async (
      key: string,
      value: ArrayBuffer | ReadableStream<Uint8Array> | Uint8Array,
    ) => {
      const beforePut = control.beforeNextPut;
      delete control.beforeNextPut;
      await beforePut?.();
      if (value instanceof ReadableStream) {
        throw new Error("R2 put requires a body with a known length");
      }
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      stored.set(key, bytes.slice());
    },
  } as unknown as R2Bucket;
}

function toD1(
  database: Database,
  control = {
    activateBeforeCleanupClaim: false,
    commitThenThrowImageActivation: false,
    deleteAuditBeforeRunUpdate: false,
    deleteAssigneeBeforeIssueUpdate: false,
    failNextImageActivation: false,
    failNextPendingUpdate: false,
  },
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
          control.deleteAuditBeforeRunUpdate &&
          query.includes("UPDATE audits SET responses")
        ) {
          control.deleteAuditBeforeRunUpdate = false;
          const auditId = values.at(-2);
          const organizationId = values.at(-1);
          if (
            typeof auditId !== "string" ||
            typeof organizationId !== "string"
          ) {
            throw new Error("Expected an audit and organization id.");
          }
          database
            .query("DELETE FROM audits WHERE id = ? AND organization_id = ?")
            .run(auditId, organizationId);
        }
        if (
          control.deleteAssigneeBeforeIssueUpdate &&
          query.includes("UPDATE audit_issues") &&
          query.includes("SELECT 1 FROM member")
        ) {
          control.deleteAssigneeBeforeIssueUpdate = false;
          const organizationId = values.at(-2);
          const userId = values.at(-1);
          fixtureMemberDeletion(database, organizationId, userId);
        }
        if (
          control.failNextImageActivation &&
          query.includes("SET size = ?, deletion_pending = 0")
        ) {
          control.failNextImageActivation = false;
          throw new Error("Transient D1 image activation failure");
        }
        if (
          control.commitThenThrowImageActivation &&
          query.includes("SET size = ?, deletion_pending = 0")
        ) {
          control.commitThenThrowImageActivation = false;
          database.query(query).run(...values);
          throw new Error("D1 activation response was lost after commit");
        }
        if (
          control.failNextPendingUpdate &&
          query.includes("SET deletion_pending = 1")
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
        first: async () => {
          if (
            control.activateBeforeCleanupClaim &&
            query.includes("SET cleanup_token = ?")
          ) {
            control.activateBeforeCleanupClaim = false;
            const objectId = values[2];
            if (typeof objectId !== "string") {
              throw new Error("Cleanup claim object id missing");
            }
            database
              .query(
                `UPDATE objects
                 SET deletion_pending = 0, cleanup_token = NULL,
                     cleanup_claimed_at = NULL, upload_token = NULL,
                     upload_lease_expires_at = NULL
                 WHERE id = ?`,
              )
              .run(objectId);
          }
          return database.query(query).get(...values);
        },
        run: async () => runSync(),
        runSync,
      };
      return statement;
    },
  } as unknown as D1Database;
}

function fixtureMemberDeletion(
  database: Database,
  organizationId: SQLQueryBindings | undefined,
  userId: SQLQueryBindings | undefined,
) {
  if (typeof organizationId !== "string" || typeof userId !== "string") {
    throw new Error("Assignee membership predicate bindings are missing");
  }
  database
    .query(`DELETE FROM member WHERE organizationId = ? AND userId = ?`)
    .run(organizationId, userId);
}

function imageUpload(
  bytes: BodyInit,
  contentType = "image/png",
  headers: Record<string, string> = {},
): RequestInit {
  return {
    body: bytes,
    headers: { "content-type": contentType, ...headers },
    method: "POST",
  };
}

function pngBytes() {
  return decodeImageFixture(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
}

function jpegBytes() {
  return decodeImageFixture(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
  );
}

function gifBytes() {
  return decodeImageFixture("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
}

function webpBytes() {
  return decodeImageFixture(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
  );
}

function decodeImageFixture(encoded: string) {
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

function imagesFor(
  dimensions: {
    expectedBytes?: Uint8Array;
    format?: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
    height?: number;
    normalizedBytes?: Uint8Array;
    onInfo?: () => Promise<void> | void;
    onOutput?: (options: ImageOutputOptions) => void;
    onTransform?: (options: Record<string, unknown>) => void;
    width?: number;
  } = {},
) {
  const readValidPng = async (stream: ReadableStream<Uint8Array>) => {
    const actual = new Uint8Array(await new Response(stream).arrayBuffer());
    const expected = dimensions.expectedBytes ?? pngBytes();
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
      await dimensions.onInfo?.();
      const actual = await readValidPng(stream);
      return {
        fileSize: actual.length,
        format: dimensions.format ?? "image/png",
        height: dimensions.height ?? 1,
        width: dimensions.width ?? 1,
      };
    },
    input: (stream: ReadableStream<Uint8Array>) => {
      const actual = readValidPng(stream);
      const transformer = {
        transform: (options: Record<string, unknown>) => {
          dimensions.onTransform?.(options);
          return transformer;
        },
        output: async (options: ImageOutputOptions) => {
          const supportedOutput = [
            "image/gif",
            "image/jpeg",
            "image/png",
            "image/webp",
          ].includes(options.format);
          if (options.anim !== false || !supportedOutput) {
            throw new Error("Test images must be normalized without animation");
          }
          dimensions.onOutput?.(options);
          const actualBytes = await actual;
          const normalized = dimensions.normalizedBytes ?? actualBytes;
          return {
            contentType: () => options.format,
            image: () => new Blob([normalized]).stream(),
            response: () =>
              new Response(normalized, {
                headers: { "content-type": options.format },
              }),
          };
        },
      };
      return transformer;
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
