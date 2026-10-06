import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { verifyCheckrWebhook } from "./checkr";
import {
  handleCheckrWebhook,
  refreshActiveCheckrScreenings,
} from "./checkrSync";
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

  it("transfers requirements when a pending invitation has expired", async () => {
    const fixture = await createFixture();
    const assigned = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        invitationId: "invite",
        requirements: [{ kind: "form", title: "W-4", dueDate: "2026-10-02" }],
      }),
    );
    expect(assigned.status).toBe(201);
    fixture.database
      .query("UPDATE invitation SET expiresAt = ? WHERE id = 'invite'")
      .run(new Date(Date.now() - 60_000).toISOString());
    fixture.database
      .query(`INSERT INTO invitation
        (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
        VALUES ('invite-2', ?, 'invitee@example.com', 'member', 'pending', ?, ?, 'owner')`)
      .run(orgId, new Date(Date.now() + 86_400_000).toISOString(), now());
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
    let reportStatus = "pending";
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
        status: reportStatus,
      });
    }) as typeof fetch;
    try {
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toMatchObject({
        invitationStatus: "completed",
        reportStatus: "pending",
      });
      expect(
        fixture.database
          .query(`SELECT status, checkr_invitation_status
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        status: "in_progress",
        checkr_invitation_status: "completed",
      });
      const blockedRemoval = await fixture
        .app("owner", "owner")
        .request(`/${id}`, { method: "DELETE" });
      expect(blockedRemoval.status).toBe(409);
      reportStatus = "complete";
      const canceled = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(canceled.status).toBe(200);
      expect(await canceled.json()).toMatchObject({
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
      expect(rejected.status).toBe(502);
      expect((await rejected.json()) as { error: string }).toEqual({
        error: "Checkr request failed (400): Package is not enabled.",
      });
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
      expect(failed.status).toBe(502);
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

  it("replays a recent idempotent start when invitation tags are empty", async () => {
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
          return Response.json({ message: "response lost" }, { status: 504 });
        }
        return Response.json({
          id: "invitation-1",
          package: "background_package",
          report_id: null,
          status: "pending",
        });
      }
      if (url.includes("/invitations?candidate_id=")) {
        return Response.json({
          data: [
            {
              id: "invitation-1",
              package: "background_package",
              report_id: null,
              status: "pending",
              tags: [],
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
      expect(failed.status).toBe(502);
      fixture.database
        .query(
          "UPDATE employee_requirements SET checkr_start_nonce_at = ? WHERE id = ?",
        )
        .run(new Date(Date.now() - 25 * 60 * 60_000).toISOString(), id);
      const stale = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(stale.status).toBe(409);
      expect(invitationKeys).toHaveLength(1);
      fixture.database
        .query(
          "UPDATE employee_requirements SET checkr_start_nonce_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), id);
      const recovered = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(recovered.status).toBe(200);
      expect(invitationKeys).toHaveLength(2);
      expect(invitationKeys[0]).toBe(invitationKeys[1]);
      expect(await recovered.json()).toMatchObject({
        invitationId: "invitation-1",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ignores tagless invitations from an earlier screening attempt", async () => {
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
                  checkr_start_nonce = 'new-attempt',
                  checkr_start_nonce_at = ?,
                  checkr_start_package = 'background_package'
              WHERE id = ?`)
      .run(new Date().toISOString(), id);
    let invitationPosts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/invitations?candidate_id=")) {
        return Response.json({
          data: [
            {
              id: "old-invitation",
              package: "background_package",
              created_at: new Date(Date.now() - 86_400_000).toISOString(),
              report_id: "old-canceled-report",
              status: "completed",
              tags: [],
            },
          ],
        });
      }
      if (url.endsWith("/invitations") && init?.method === "POST") {
        invitationPosts += 1;
        return Response.json({
          id: "new-invitation",
          report_id: null,
          status: "pending",
        });
      }
      throw new Error(`Unexpected Checkr request: ${url}`);
    }) as typeof fetch;
    try {
      const started = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/start`, jsonPost({ state: "NY" }));
      expect(started.status).toBe(200);
      expect(invitationPosts).toBe(1);
      expect(await started.json()).toMatchObject({
        invitationId: "new-invitation",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lets managers reconcile an older tagless Checkr invitation", async () => {
    const fixture = await createFixture();
    fixture.bindings.CHECKR_API_KEY = "staging-key";
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_candidate_id = 'candidate-1',
                  checkr_start_nonce = 'old-attempt',
                  checkr_start_nonce_at = ?,
                  checkr_start_package = 'background_package'
              WHERE id = ?`)
      .run(new Date(Date.now() - 25 * 60 * 60_000).toISOString(), id);
    let candidateId = "other-candidate";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        id: "invitation-1",
        candidate_id: candidateId,
        created_at: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
        package: "background_package",
        report_id: null,
        status: "pending",
        tags: [],
      })) as unknown as typeof fetch;
    try {
      const wrongCandidate = await fixture
        .app("owner", "owner")
        .request(
          `/${id}/checkr/reconcile`,
          jsonPost({ invitationId: "invitation-1" }),
        );
      expect(wrongCandidate.status).toBe(409);
      candidateId = "candidate-1";
      const linked = await fixture
        .app("owner", "owner")
        .request(
          `/${id}/checkr/reconcile`,
          jsonPost({ invitationId: "invitation-1" }),
        );
      expect(linked.status).toBe(200);
      expect(
        fixture.database
          .query(`SELECT checkr_start_nonce, checkr_invitation_id, status
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_start_nonce: null,
        checkr_invitation_id: "invitation-1",
        status: "in_progress",
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
      expect(first.status).toBe(502);
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

  it("verifies Checkr webhook signatures with Checkr's published example", async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ monday: "75F", tuesday: "80F" }),
    );
    const signature =
      "b7412f05e981a473b5ecbdb5393afaea02a679db6d7c8e56803512ec4ba98151";
    expect(await verifyCheckrWebhook(payload, signature, "test-secret")).toBe(
      true,
    );
    expect(await verifyCheckrWebhook(payload, signature, "other-key")).toBe(
      false,
    );
    expect(await verifyCheckrWebhook(payload, "not-hex", "test-secret")).toBe(
      false,
    );
    expect(await verifyCheckrWebhook(payload, undefined, "test-secret")).toBe(
      false,
    );
  });

  it("refreshes a screening from a signed Checkr invitation webhook", async () => {
    const fixture = await createFixture();
    const id = await startedScreening(fixture);
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      if (String(input).includes("/invitations/invitation-1?")) {
        return Response.json({
          id: "invitation-1",
          report_id: "report-1",
          status: "completed",
        });
      }
      return Response.json({
        id: "report-1",
        result: "clear",
        status: "complete",
      });
    }) as typeof fetch;
    try {
      const event = {
        id: "event-1",
        object: "event",
        type: "invitation.completed",
        data: { object: { id: "invitation-1", object: "invitation" } },
      };
      const unconfigured = await checkrWebhook(
        withoutCheckrKey(fixture.bindings),
        event,
      );
      expect(unconfigured.status).toBe(503);
      const forged = await checkrWebhook(fixture.bindings, event, "other-key");
      expect(forged.status).toBe(400);
      const unsigned = await checkrWebhook(fixture.bindings, event, null);
      expect(unsigned.status).toBe(400);
      expect(requests).toEqual([]);

      const ignored = await checkrWebhook(fixture.bindings, {
        ...event,
        type: "candidate.created",
        data: { object: { id: "candidate-1", object: "candidate" } },
      });
      expect(ignored.status).toBe(200);
      const malformed = await checkrWebhook(fixture.bindings, {
        type: "invitation.completed",
        data: {},
      });
      expect(malformed.status).toBe(400);
      expect(requests).toEqual([]);

      const received = await checkrWebhook(fixture.bindings, event);
      expect(received.status).toBe(200);
      expect((await received.json()) as { received: boolean }).toEqual({
        received: true,
      });
      expect(requests).toEqual([
        "https://api.checkr-staging.com/v1/invitations/invitation-1?include_deleted=true",
        "https://api.checkr-staging.com/v1/reports/report-1",
      ]);
      expect(
        fixture.database
          .query(`SELECT status, checkr_report_id, checkr_result,
                         checkr_invitation_status, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        status: "complete",
        checkr_report_id: "report-1",
        checkr_result: "clear",
        checkr_invitation_status: "completed",
        checkr_refresh_requested_at: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("links a Checkr report webhook to its screening through the candidate", async () => {
    const fixture = await createFixture();
    const id = await startedScreening(fixture);
    const requests: string[] = [];
    let checkrAvailable = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (!checkrAvailable) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (url.endsWith("/reports/stranger-report")) {
        return Response.json({
          candidate_id: "someone-else",
          id: "stranger-report",
          status: "complete",
        });
      }
      if (url.includes("/invitations/invitation-1?")) {
        return Response.json({
          id: "invitation-1",
          report_id: "report-9",
          status: "completed",
        });
      }
      return Response.json({
        candidate_id: "candidate-1",
        id: "report-9",
        result: "consider",
        status: "complete",
      });
    }) as typeof fetch;
    try {
      const stranger = await checkrWebhook(fixture.bindings, {
        type: "report.completed",
        data: { object: { id: "stranger-report", object: "report" } },
      });
      expect(stranger.status).toBe(200);
      expect(requests).toEqual([
        "https://api.checkr-staging.com/v1/reports/stranger-report",
      ]);

      checkrAvailable = false;
      requests.length = 0;
      const unavailable = await checkrWebhook(fixture.bindings, {
        type: "report.completed",
        data: { object: { id: "report-9", object: "report" } },
      });
      expect(unavailable.status).toBe(200);
      expect(
        fixture.database
          .query("SELECT status FROM employee_requirements WHERE id = ?")
          .get(id),
      ).toEqual({ status: "in_progress" });

      checkrAvailable = true;
      requests.length = 0;
      const completed = await checkrWebhook(fixture.bindings, {
        type: "report.completed",
        data: { object: { id: "report-9", object: "report" } },
      });
      expect(completed.status).toBe(200);
      expect(requests).toEqual([
        "https://api.checkr-staging.com/v1/reports/report-9",
        "https://api.checkr-staging.com/v1/invitations/invitation-1?include_deleted=true",
        "https://api.checkr-staging.com/v1/reports/report-9",
      ]);
      expect(
        fixture.database
          .query(`SELECT status, checkr_report_id, checkr_result
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        status: "complete",
        checkr_report_id: "report-9",
        checkr_result: "consider",
      });

      requests.length = 0;
      const duplicate = await checkrWebhook(fixture.bindings, {
        type: "report.completed",
        data: { object: { id: "report-9", object: "report" } },
      });
      expect(duplicate.status).toBe(200);
      expect(requests).toEqual([
        "https://api.checkr-staging.com/v1/invitations/invitation-1?include_deleted=true",
        "https://api.checkr-staging.com/v1/reports/report-9",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refreshes unfinished Checkr screenings on schedule", async () => {
    const fixture = await createFixture();
    const active = await startedScreening(fixture);
    const failing = await startedScreening(fixture, "invitation-2");
    const finished = await startedScreening(fixture, "invitation-3");
    const expired = await startedScreening(fixture, "invitation-4");
    const manual = await createRequirement(
      fixture,
      "background_check",
      "Manual check",
    );
    fixture.database
      .query(
        "UPDATE employee_requirements SET status = 'complete' WHERE id = ?",
      )
      .run(finished);
    fixture.database
      .query(`UPDATE employee_requirements
              SET status = 'pending', checkr_invitation_status = 'expired'
              WHERE id = ?`)
      .run(expired);
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/invitations/invitation-2?")) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return Response.json({
        id: "invitation-1",
        report_id: null,
        status: "pending",
      });
    }) as typeof fetch;
    try {
      expect(
        await refreshActiveCheckrScreenings(withoutCheckrKey(fixture.bindings)),
      ).toEqual({ refreshed: 0, skipped: true });
      expect(requests).toEqual([]);
      await expect(
        refreshActiveCheckrScreenings(fixture.bindings),
      ).rejects.toThrow("Could not refresh 1 Checkr screening(s).");
      expect(requests.toSorted()).toEqual([
        "https://api.checkr-staging.com/v1/invitations/invitation-1?include_deleted=true",
        "https://api.checkr-staging.com/v1/invitations/invitation-2?include_deleted=true",
      ]);
      const rows = fixture.database
        .query(`SELECT id, checkr_refresh_revision
                FROM employee_requirements ORDER BY id`)
        .all() as Array<{ id: string; checkr_refresh_revision: number }>;
      const revisions = Object.fromEntries(
        rows.map((row) => [row.id, row.checkr_refresh_revision]),
      );
      expect(revisions[active]).toBe(1);
      expect(revisions[failing]).toBe(0);
      expect(revisions[finished]).toBe(0);
      expect(revisions[expired]).toBe(0);
      expect(revisions[manual]).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rotates scheduled Checkr refreshes past screenings that keep failing", async () => {
    const fixture = await createFixture();
    const invitations = Array.from(
      { length: 26 },
      (_, index) => `rotating-${String(index).padStart(2, "0")}`,
    );
    for (const invitation of invitations) {
      await startedScreening(fixture, invitation);
    }
    const attempted: string[][] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const invitation = /invitations\/([^?]+)/.exec(String(input))?.[1];
      if (invitation) attempted.at(-1)?.push(invitation);
      return Response.json({ error: "unavailable" }, { status: 503 });
    }) as typeof fetch;
    try {
      for (let run = 0; run < 2; run += 1) {
        attempted.push([]);
        await expect(
          refreshActiveCheckrScreenings(fixture.bindings),
        ).rejects.toThrow("Could not refresh 24 Checkr screening(s).");
      }
      expect(attempted[0]).toHaveLength(24);
      const skipped = invitations.filter(
        (invitation) => !attempted[0]?.includes(invitation),
      );
      expect(skipped).toHaveLength(2);
      for (const invitation of skipped) {
        expect(attempted[1]).toContain(invitation);
      }
      expect(
        fixture.database
          .query(`SELECT COUNT(*) AS unchecked FROM employee_requirements
                  WHERE checkr_checked_at IS NULL`)
          .get(),
      ).toEqual({ unchecked: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries a failed webhook refresh even after the screening completed", async () => {
    const fixture = await createFixture();
    const id = await startedScreening(fixture);
    fixture.database
      .query(`UPDATE employee_requirements
              SET status = 'complete', checkr_report_id = 'report-1',
                  checkr_result = 'clear',
                  checkr_invitation_status = 'completed'
              WHERE id = ?`)
      .run(id);
    let checkrAvailable = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (!checkrAvailable) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (String(input).includes("/invitations/invitation-1?")) {
        return Response.json({
          id: "invitation-1",
          report_id: "report-1",
          status: "completed",
        });
      }
      return Response.json({ id: "report-1", result: null, status: "pending" });
    }) as typeof fetch;
    try {
      const upgraded = await checkrWebhook(fixture.bindings, {
        type: "report.upgraded",
        data: { object: { id: "report-1", object: "report" } },
      });
      expect(upgraded.status).toBe(200);
      const requested = fixture.database
        .query(`SELECT status, checkr_refresh_requested_at
                FROM employee_requirements WHERE id = ?`)
        .get(id) as { status: string; checkr_refresh_requested_at: string };
      expect(requested.status).toBe("complete");
      expect(requested.checkr_refresh_requested_at).toEqual(expect.any(String));

      checkrAvailable = true;
      expect(await refreshActiveCheckrScreenings(fixture.bindings)).toEqual({
        refreshed: 1,
        skipped: false,
      });
      expect(
        fixture.database
          .query(`SELECT status, checkr_result, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        status: "in_progress",
        checkr_result: null,
        checkr_refresh_requested_at: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a Checkr refresh request that a racing refresh cannot settle", async () => {
    const newer = "2999-01-01T00:00:00.000Z";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        id: "invitation-1",
        report_id: null,
        status: "pending",
      })) as unknown as typeof fetch;
    try {
      const requestedDuringRefresh = await createFixture();
      const first = await startedScreening(requestedDuringRefresh);
      beforeCheckrRefreshWrite(requestedDuringRefresh, () => {
        requestedDuringRefresh.database
          .query(`UPDATE employee_requirements
                  SET checkr_refresh_requested_at = ? WHERE id = ?`)
          .run(newer, first);
      });
      const delivered = await checkrWebhook(requestedDuringRefresh.bindings, {
        type: "invitation.completed",
        data: { object: { id: "invitation-1", object: "invitation" } },
      });
      expect(delivered.status).toBe(200);
      expect(
        requestedDuringRefresh.database
          .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(first),
      ).toEqual({
        checkr_refresh_revision: 1,
        checkr_refresh_requested_at: newer,
      });

      const conflicted = await createFixture();
      const second = await startedScreening(conflicted);
      beforeCheckrRefreshWrite(conflicted, () => {
        conflicted.database
          .query(`UPDATE employee_requirements
                  SET checkr_refresh_revision = checkr_refresh_revision + 1
                  WHERE id = ?`)
          .run(second);
      });
      const raced = await checkrWebhook(conflicted.bindings, {
        type: "invitation.completed",
        data: { object: { id: "invitation-1", object: "invitation" } },
      });
      expect(raced.status).toBe(200);
      const kept = conflicted.database
        .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                FROM employee_requirements WHERE id = ?`)
        .get(second) as {
        checkr_refresh_revision: number;
        checkr_refresh_requested_at: string | null;
      };
      expect(kept.checkr_refresh_revision).toBe(1);
      expect(kept.checkr_refresh_requested_at).toEqual(expect.any(String));
      expect(await refreshActiveCheckrScreenings(conflicted.bindings)).toEqual({
        refreshed: 1,
        skipped: false,
      });
      expect(
        conflicted.database
          .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(second),
      ).toEqual({
        checkr_refresh_revision: 2,
        checkr_refresh_requested_at: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function startedScreening(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  invitationId = "invitation-1",
) {
  fixture.bindings.CHECKR_API_KEY = "staging-key";
  fixture.bindings.CHECKR_ENV = "staging";
  const id = await createRequirement(
    fixture,
    "background_check",
    "Background check",
  );
  fixture.database
    .query(`UPDATE employee_requirements
            SET checkr_candidate_id = ?, checkr_invitation_id = ?,
                checkr_invitation_status = 'pending', status = 'in_progress'
            WHERE id = ?`)
    .run(
      invitationId === "invitation-1" ? "candidate-1" : `candidate-${id}`,
      invitationId,
      id,
    );
  return id;
}

// Runs action just before a Checkr refresh records its result, skipping any
// earlier writes such as a webhook's refresh request.
function beforeCheckrRefreshWrite(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  action: () => void,
) {
  const arm = () => {
    fixture.beforeRun((query) => {
      if (
        query.includes("checkr_refresh_revision = checkr_refresh_revision + 1")
      ) {
        action();
      } else {
        arm();
      }
    });
  };
  arm();
}

function withoutCheckrKey(bindings: Bindings): Bindings {
  const { CHECKR_API_KEY: _apiKey, ...configured } = bindings;
  return configured;
}

async function checkrWebhook(
  bindings: Bindings,
  event: unknown,
  signingKey: string | null = "staging-key",
) {
  const body = JSON.stringify(event);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (signingKey) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    headers.set("X-Checkr-Signature", Buffer.from(digest).toString("hex"));
  }
  const app = new Hono<{ Bindings: Bindings }>();
  app.post("/webhook", handleCheckrWebhook);
  const background: Promise<unknown>[] = [];
  const executionContext = {
    passThroughOnException: () => undefined,
    props: {},
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  } as unknown as ExecutionContext;
  const response = await app.request(
    "/webhook",
    { body, headers, method: "POST" },
    bindings,
    executionContext,
  );
  await Promise.all(background);
  return response;
}

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
  await migration(database, "0052_track_checkr_refreshes.sql");
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
