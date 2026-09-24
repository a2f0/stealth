import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { purgeDeletedObjects } from "./deletedObjectCleanup";
import {
  assignAcceptedInvitationRequirements,
  assignRenewedInvitationRequirements,
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
    for (const documentRevision of [{ invalid: true }, [1], null]) {
      const malformedRevision = await fixture
        .app("owner", "owner")
        .request(`/${id}`, {
          body: JSON.stringify({
            dueDate: "2026-10-10",
            documentRevision,
          }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
      expect(malformedRevision.status).toBe(400);
    }
    const checkId = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const malformedCheckRevision = await fixture
      .app("owner", "owner")
      .request(`/${checkId}`, {
        body: JSON.stringify({
          status: "in_progress",
          documentRevision: { invalid: true },
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
    expect(malformedCheckRevision.status).toBe(400);
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

  it("retains requirements when an invitation is renewed", async () => {
    const fixture = await createFixture();
    const response = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        invitationId: "invite",
        requirements: [{ kind: "form", title: "W-4", dueDate: "2026-10-02" }],
      }),
    );
    expect(response.status).toBe(201);
    fixture.database
      .query("UPDATE invitation SET status = 'canceled' WHERE id = 'invite'")
      .run();
    fixture.database
      .query(`INSERT INTO invitation
        (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
        VALUES ('invite-2', ?, 'invitee@example.com', 'member', 'pending', ?, ?, 'owner')`)
      .run(orgId, "2026-10-05", now());
    await assignRenewedInvitationRequirements(
      fixture.bindings.DB,
      orgId,
      "invite-2",
      "invitee@example.com",
    );
    expect(
      fixture.database
        .query("SELECT invitation_id FROM employee_requirements")
        .get(),
    ).toEqual({ invitation_id: "invite-2" });
    fixture.database
      .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
              VALUES ('new-member', ?, 'invitee', 'member', ?)`)
      .run(orgId, now());
    await assignAcceptedInvitationRequirements(
      fixture.bindings.DB,
      orgId,
      "invite-2",
      "new-member",
    );
    expect(
      fixture.database
        .query("SELECT invitation_id, member_id FROM employee_requirements")
        .get(),
    ).toEqual({ invitation_id: null, member_id: "new-member" });
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

  it("blocks manual completion while a Checkr start is unresolved", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(
        "UPDATE employee_requirements SET checkr_start_nonce = 'pending' WHERE id = ?",
      )
      .run(id);
    const pending = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(pending.status).toBe(400);
    const dueDate = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ dueDate: "2026-10-10" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(dueDate.status).toBe(200);

    fixture.database
      .query(
        "UPDATE employee_requirements SET checkr_start_nonce = NULL WHERE id = ?",
      )
      .run(id);
    fixture.beforeRun((query) => {
      if (query.includes("SET status = COALESCE")) {
        fixture.database
          .query(
            "UPDATE employee_requirements SET checkr_start_nonce = 'raced' WHERE id = ?",
          )
          .run(id);
      }
    });
    const raced = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(raced.status).toBe(409);
    expect(
      fixture.database
        .query("SELECT status FROM employee_requirements WHERE id = ?")
        .get(id),
    ).toEqual({ status: "pending" });
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
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM deleted_object_cleanup WHERE id LIKE 'employee-form-upload:%'",
        )
        .get(),
    ).toEqual({ count: 0 });
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
    const downloadedRevision = Number(
      download.headers.get("x-document-revision"),
    );
    expect(downloadedRevision).toBe(1);

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
      body: JSON.stringify({
        status: "complete",
        documentRevision: downloadedRevision,
      }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(staleReview.status).toBe(409);

    const latestDownload = await fixture
      .app("owner", "owner")
      .request(`/${id}/document`);
    expect(await latestDownload.text()).toBe("updated form");
    const latestRevision = Number(
      latestDownload.headers.get("x-document-revision"),
    );
    expect(latestRevision).toBe(2);

    const reviewed = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({
        status: "complete",
        documentRevision: latestRevision,
      }),
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
    const formerMember = await fixture
      .app("employee", "member")
      .request(`/${id}/document`);
    expect(formerMember.status).toBe(404);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("purges an uploaded form after an interrupted request", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    fixture.storageState.failPutAfterWrite = true;
    fixture.storageState.failDelete = true;
    const form = new FormData();
    form.set(
      "file",
      new File(["private"], "tax.pdf", { type: "application/pdf" }),
    );
    const failed = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(failed.status).toBe(500);
    expect(fixture.files.size).toBe(1);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 1 });
    fixture.storageState.failDelete = false;
    await purgeDeletedObjects(fixture.bindings, {
      abandonedClaimedBefore: new Date(Date.now() + 60_000).toISOString(),
      deletedBefore: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(fixture.files.size).toBe(0);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("keeps a form when the database commits but its response is lost", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    fixture.afterRun(() => {
      throw new Error("D1 response lost.");
    });
    const form = new FormData();
    form.set(
      "file",
      new File(["saved form"], "tax.pdf", { type: "application/pdf" }),
    );
    const uploaded = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(uploaded.status).toBe(200);
    expect(fixture.files.size).toBe(1);
    const downloaded = await fixture
      .app("employee", "member")
      .request(`/${id}/document`);
    expect(await downloaded.text()).toBe("saved form");
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("does not link a form after cleanup claims its upload", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    fixture.beforeDocumentUpdate(() => {
      fixture.database
        .query(
          "UPDATE deleted_object_cleanup SET cleanup_token = 'worker' WHERE id LIKE 'employee-form-upload:%'",
        )
        .run();
    });
    const form = new FormData();
    form.set(
      "file",
      new File(["stale"], "tax.pdf", { type: "application/pdf" }),
    );
    const uploaded = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(uploaded.status).toBe(409);
    expect(
      fixture.database
        .query("SELECT document_key FROM employee_requirements WHERE id = ?")
        .get(id),
    ).toEqual({ document_key: null });
  });

  it("rejects oversized multipart uploads before parsing them", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(11 * 1024 * 1024)], "large.pdf", {
        type: "application/pdf",
      }),
    );
    const upload = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(upload.status).toBe(413);
    expect(fixture.files.size).toBe(0);
  });

  it("retains active screenings after a membership is removed", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_invitation_id = 'active-check', checkr_invitation_status = 'pending'
              WHERE id = ?`)
      .run(id);
    fixture.database
      .query("DELETE FROM member WHERE id = 'employee-member'")
      .run();
    expect(
      fixture.database
        .query(
          "SELECT member_id, target_email, checkr_invitation_id FROM employee_requirements WHERE id = ?",
        )
        .get(id),
    ).toEqual({
      member_id: null,
      target_email: "employee@example.com",
      checkr_invitation_id: "active-check",
    });
    const removal = await fixture.app("owner", "owner").request(`/${id}`, {
      method: "DELETE",
    });
    expect(removal.status).toBe(409);
  });

  it("allows manual completion after a Checkr invitation expires", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_invitation_id = 'expired-check',
                  checkr_invitation_status = 'expired' WHERE id = ?`)
      .run(id);
    const completed = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(completed.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT status FROM employee_requirements WHERE id = ?")
        .get(id),
    ).toEqual({ status: "complete" });
  });

  it("does not transfer a former member's forms to a reused email", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    const form = new FormData();
    form.set(
      "file",
      new File(["private tax form"], "tax.pdf", { type: "application/pdf" }),
    );
    const uploaded = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(uploaded.status).toBe(200);
    fixture.database
      .query("DELETE FROM member WHERE id = 'employee-member'")
      .run();
    fixture.database
      .query(`INSERT INTO invitation
        (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
        VALUES ('replacement-invite', ?, 'employee@example.com', 'member',
                'pending', ?, ?, 'owner')`)
      .run(orgId, "2026-10-05", now());
    await assignRenewedInvitationRequirements(
      fixture.bindings.DB,
      orgId,
      "replacement-invite",
      "employee@example.com",
    );
    expect(
      fixture.database
        .query(
          "SELECT invitation_id, assigned_user_id FROM employee_requirements WHERE id = ?",
        )
        .get(id),
    ).toEqual({ invitation_id: null, assigned_user_id: "employee" });
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
      if (String(input).includes("/invitations/invitation-1?")) {
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
      fixture.database
        .query(
          "UPDATE employee_requirements SET completed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
        )
        .run(id);
      const refreshedAgain = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(refreshedAgain.status).toBe(200);
      expect(
        fixture.database
          .query("SELECT completed_at FROM employee_requirements WHERE id = ?")
          .get(id),
      ).toEqual({ completed_at: "2026-01-01T00:00:00.000Z" });
      const visible = await fixture.app("employee", "member").request("/");
      const body = (await visible.json()) as {
        requirements: Array<{ checkrResult: string | null }>;
      };
      expect(body.requirements[0]?.checkrResult).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not complete a report with canceled screenings", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_invitation_id = 'invitation-1',
                  checkr_invitation_status = 'pending', status = 'in_progress'
              WHERE id = ?`)
      .run(id);
    let reportResult: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/invitations/invitation-1?")) {
        return Response.json({
          id: "invitation-1",
          report_id: "report-1",
          status: "completed",
        });
      }
      return Response.json({
        id: "report-1",
        includes_canceled: true,
        result: reportResult,
        status: "complete",
      });
    }) as typeof fetch;
    try {
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toMatchObject({
        invitationStatus: "canceled",
        result: null,
      });
      expect(
        fixture.database
          .query(`SELECT status, completed_at, checkr_invitation_status
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        status: "pending",
        completed_at: null,
        checkr_invitation_status: "canceled",
      });
      reportResult = "consider";
      const partial = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(partial.status).toBe(200);
      expect(await partial.json()).toMatchObject({
        invitationStatus: "partially_canceled",
        result: "consider",
      });
      expect(
        fixture.database
          .query(`SELECT status, checkr_result, checkr_invitation_status
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        status: "pending",
        checkr_result: "consider",
        checkr_invitation_status: "partially_canceled",
      });
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
      if (url.includes("/invitations/invitation-1?")) {
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
      const manuallyCompleted = await fixture
        .app("owner", "owner")
        .request(`/${id}`, {
          body: JSON.stringify({ status: "complete" }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
      expect(manuallyCompleted.status).toBe(200);
      expect(
        fixture.database
          .query("SELECT completed_at FROM employee_requirements WHERE id = ?")
          .get(id),
      ).toMatchObject({ completed_at: expect.any(String) });
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
            "SELECT checkr_invitation_id, checkr_attempt, completed_at FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        checkr_invitation_id: "invitation-2",
        checkr_attempt: 1,
        completed_at: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retrieves a canceled Checkr invitation for restart", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "background_package";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_candidate_id = 'candidate-1',
                  checkr_invitation_id = 'invitation-1',
                  checkr_invitation_status = 'pending', status = 'in_progress'
              WHERE id = ?`)
      .run(id);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/invitations/invitation-1?include_deleted=true")) {
        return Response.json({
          id: "invitation-1",
          deleted_at: new Date().toISOString(),
          report_id: null,
          status: "pending",
        });
      }
      if (url.endsWith("/invitations") && init?.method === "POST") {
        return Response.json({
          id: "invitation-2",
          report_id: null,
          status: "pending",
        });
      }
      throw new Error(`Unexpected Checkr request: ${url}`);
    }) as typeof fetch;
    try {
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toMatchObject({
        invitationStatus: "deleted",
      });
      const restarted = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(restarted.status).toBe(200);
      expect(await restarted.json()).toMatchObject({
        invitationId: "invitation-2",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a completed screening when an older refresh finishes last", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_invitation_id = 'check-1',
                  checkr_invitation_status = 'pending', status = 'in_progress'
              WHERE id = ?`)
      .run(id);
    fixture.beforeRun((query) => {
      if (
        query.includes("checkr_refresh_revision = checkr_refresh_revision + 1")
      ) {
        fixture.database
          .query(`UPDATE employee_requirements
                  SET status = 'complete', checkr_result = 'clear',
                      checkr_refresh_revision = 1 WHERE id = ?`)
          .run(id);
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        id: "check-1",
        deleted_at: null,
        report_id: null,
        status: "pending",
      })) as unknown as typeof fetch;
    try {
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(refreshed.status).toBe(409);
      expect(
        fixture.database
          .query(
            "SELECT status, checkr_result FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ status: "complete", checkr_result: "clear" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps manual completion when an expired invitation refresh overlaps", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_invitation_id = 'check-1',
                  checkr_invitation_status = 'expired' WHERE id = ?`)
      .run(id);
    let manualStatus = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      manualStatus = (
        await fixture.app("owner", "owner").request(`/${id}`, {
          body: JSON.stringify({ status: "complete" }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        })
      ).status;
      return Response.json({
        id: "check-1",
        report_id: null,
        status: "expired",
      });
    }) as unknown as typeof fetch;
    try {
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(manualStatus).toBe(200);
      expect(refreshed.status).toBe(409);
      expect(
        fixture.database
          .query(
            "SELECT status, checkr_refresh_revision FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ status: "complete", checkr_refresh_revision: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lets managers remove a screening after a definite Checkr rejection", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "background_package";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/candidates")) {
        return Response.json({ id: "candidate-1" });
      }
      if (String(input).endsWith("/invitations")) {
        return Response.json(
          { message: "Package is not enabled." },
          { status: 400 },
        );
      }
      throw new Error(`Unexpected Checkr request: ${input}`);
    }) as typeof fetch;
    try {
      const rejected = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(rejected.status).toBe(500);
      expect(
        fixture.database
          .query(
            "SELECT checkr_start_nonce FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_start_nonce: null });
      const removed = await fixture.app("owner", "owner").request(`/${id}`, {
        method: "DELETE",
      });
      expect(removed.status).toBe(200);
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
    let attemptTag = "";
    let includeExpected = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/candidates")) {
        return Response.json({ id: "candidate-1" });
      }
      if (url.endsWith("/invitations") && init?.method === "POST") {
        invitationPosts += 1;
        attemptTag = new URLSearchParams(String(init.body)).get("tags[]") ?? "";
        return Response.json({ message: "response lost" }, { status: 504 });
      }
      if (url.includes("/invitations?candidate_id=")) {
        return Response.json({
          data: [
            {
              id: "unrelated-credit-invitation",
              package: "credit_package",
              tags: [attemptTag],
              report_id: "unrelated-report",
              status: "completed",
            },
            {
              id: "older-background-invitation",
              package: "background_package",
              tags: ["tearleads-screening:older-attempt"],
              report_id: null,
              status: "pending",
            },
            {
              id: "tagless-background-invitation",
              package: "background_package",
              report_id: null,
              status: "pending",
            },
            ...(includeExpected
              ? [
                  {
                    id: "invitation-1",
                    package: "background_package",
                    tags: [attemptTag],
                    report_id: null,
                    status: "pending",
                  },
                ]
              : []),
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
      fixture.database
        .query("DELETE FROM member WHERE id = 'employee-member'")
        .run();
      const removal = await fixture.app("owner", "owner").request(`/${id}`, {
        method: "DELETE",
      });
      expect(removal.status).toBe(409);
      delete fixture.bindings.CHECKR_BACKGROUND_PACKAGE;
      const mismatched = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(mismatched.status).toBe(409);
      expect(
        fixture.database
          .query(
            "SELECT checkr_invitation_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_invitation_id: null });
      includeExpected = true;
      fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "changed_package";
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

  it("reconciles an unresolved screening after its invitation is canceled", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "background_package";
    const assigned = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        invitationId: "invite",
        requirements: [
          {
            kind: "background_check",
            title: "Background check",
            dueDate: "2026-10-01",
          },
        ],
      }),
    );
    const id = ((await assigned.json()) as { ids: string[] }).ids[0] ?? "";
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_candidate_id = 'candidate-1',
                  checkr_start_nonce = 'unresolved-nonce',
                  checkr_start_package = 'background_package',
                  checkr_start_nonce_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
    fixture.database
      .query("UPDATE invitation SET status = 'canceled' WHERE id = 'invite'")
      .run();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/invitations?candidate_id=")) {
        return Response.json({
          data: [
            {
              id: "check-1",
              package: "background_package",
              tags: ["tearleads-screening:unresolved-nonce"],
              report_id: null,
              status: "pending",
            },
          ],
        });
      }
      throw new Error(`Unexpected Checkr request: ${input}`);
    }) as typeof fetch;
    try {
      const recovered = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ invitationId: "check-1" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not order a new screening for a former member", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "background_package";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_candidate_id = 'candidate-1',
                  checkr_start_nonce = 'unresolved-nonce',
                  checkr_start_nonce_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), id);
    fixture.database
      .query("DELETE FROM member WHERE id = 'employee-member'")
      .run();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/invitations?candidate_id=")) {
        return Response.json({ data: [] });
      }
      throw new Error(`Unexpected Checkr request: ${input}`);
    }) as typeof fetch;
    try {
      const resumed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(resumed.status).toBe(409);
      expect(
        fixture.database
          .query(
            "SELECT checkr_start_nonce FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_start_nonce: null });
      const removed = await fixture.app("owner", "owner").request(`/${id}`, {
        method: "DELETE",
      });
      expect(removed.status).toBe(200);
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
  await migration(database, "0045_track_employee_form_uploads.sql");
  await migration(database, "0046_version_employee_screening_refresh.sql");
  await migration(database, "0047_bind_employee_screening_attempt.sql");
  const files = new Map<string, File>();
  const storageState = { failPutAfterWrite: false, failDelete: false };
  const hooks: {
    beforeBatch: (() => void) | undefined;
    beforeRun: ((query: string) => void) | undefined;
    afterRun: (() => void) | undefined;
    beforeDocumentUpdate: (() => void) | undefined;
  } = {
    beforeBatch: undefined,
    beforeRun: undefined,
    afterRun: undefined,
    beforeDocumentUpdate: undefined,
  };
  const bindings = {
    DB: toD1(database, hooks),
    STORAGE: {
      put: async (key: string, file: File) => {
        files.set(key, file);
        if (storageState.failPutAfterWrite) {
          throw new Error("Upload interrupted.");
        }
      },
      delete: async (key: string) => {
        if (storageState.failDelete) throw new Error("Storage unavailable.");
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
    afterRun: (callback: () => void) => {
      hooks.afterRun = callback;
    },
    beforeDocumentUpdate: (callback: () => void) => {
      hooks.beforeDocumentUpdate = callback;
    },
    database,
    files,
    storageState,
  };
}

function toD1(
  database: Database,
  hooks: {
    beforeBatch: (() => void) | undefined;
    beforeRun: ((query: string) => void) | undefined;
    afterRun: (() => void) | undefined;
    beforeDocumentUpdate: (() => void) | undefined;
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
          if (
            query.includes("SET document_key = ?") &&
            hooks.beforeDocumentUpdate
          ) {
            const before = hooks.beforeDocumentUpdate;
            hooks.beforeDocumentUpdate = undefined;
            before();
          }
          const callback = hooks.beforeRun;
          hooks.beforeRun = undefined;
          callback?.(query);
          const result = database.query(query).run(...values);
          if (query.includes("SET document_key = ?") && hooks.afterRun) {
            const after = hooks.afterRun;
            hooks.afterRun = undefined;
            after();
          }
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
