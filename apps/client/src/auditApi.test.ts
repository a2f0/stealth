import { describe, expect, it } from "bun:test";
import {
  appendIssueImageSelection,
  uploadIssueImagesSequentially,
} from "./AuditRunPage";
import {
  AuditApiError,
  type AuditTemplate,
  auditIssueImageUrl,
  copyAuditTemplate,
  createAuditTemplate,
  deleteAuditIssueImage,
  getAuditTemplateVersion,
  listAuditTemplateVersions,
  updateAuditIssue,
  updateAuditTemplate,
  uploadAuditIssueImage,
} from "./auditApi";
import { apiUrl } from "./config";

describe("audit template API", () => {
  it("sends scope and version information through the template lifecycle", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ body?: string; method: string; url: string }> = [];
    const template = exampleTemplate();
    globalThis.fetch = (async (input, init) => {
      const request: { body?: string; method: string; url: string } = {
        method: init?.method ?? "GET",
        url: input.toString(),
      };
      if (init?.body) request.body = init.body.toString();
      requests.push(request);
      expect(init?.credentials).toBe("include");
      if (input.toString().endsWith("/versions")) {
        return Response.json({ versions: [] });
      }
      return Response.json({ template });
    }) as typeof fetch;

    try {
      await createAuditTemplate("Shared form", "global");
      await getAuditTemplateVersion("template/id", 2);
      await listAuditTemplateVersions("template/id");
      await updateAuditTemplate(template);
      await copyAuditTemplate(template);
      expect(requests).toEqual([
        {
          body: JSON.stringify({ name: "Shared form", scope: "global" }),
          method: "POST",
          url: `${apiUrl}/api/audits/templates`,
        },
        {
          method: "GET",
          url: `${apiUrl}/api/audits/templates/template%2Fid/versions/2`,
        },
        {
          method: "GET",
          url: `${apiUrl}/api/audits/templates/template%2Fid/versions`,
        },
        {
          body: JSON.stringify({
            definition: template.definition,
            description: template.description,
            expectedCurrentVersion: 2,
            name: template.name,
          }),
          method: "PUT",
          url: `${apiUrl}/api/audits/templates/template%2Fid`,
        },
        {
          body: JSON.stringify({
            definition: template.definition,
            description: template.description,
            expectedCurrentVersion: 2,
            name: template.name,
          }),
          method: "POST",
          url: `${apiUrl}/api/audits/templates/template%2Fid/copies`,
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("audit issue API", () => {
  it("keeps images selected across multiple picker passes", () => {
    const first = new File([new Uint8Array([1])], "first.png", {
      type: "image/png",
    });
    const second = new File([new Uint8Array([2])], "second.png", {
      type: "image/png",
    });

    const firstSelection = appendIssueImageSelection([], [first]);
    expect(firstSelection).toEqual([first]);
    if (typeof firstSelection === "string") throw new Error(firstSelection);
    expect(appendIssueImageSelection(firstSelection, [second])).toEqual([
      first,
      second,
    ]);

    const nineExisting = Array.from(
      { length: 9 },
      (_, index) =>
        new File([new Uint8Array([index])], `${index}.png`, {
          type: "image/png",
        }),
    );
    expect(appendIssueImageSelection(nineExisting, [first, second])).toBe(
      "You can attach 1 more image.",
    );
  });

  it("updates assignees and uploads and removes images", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      init: RequestInit | undefined;
      url: string;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = input.toString();
      requests.push({ init: init as RequestInit | undefined, url });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.body instanceof File) {
        return Response.json({
          image: {
            contentType: "image/png",
            createdAt: "2026-08-25T12:00:00.000Z",
            filename: "panel.png",
            id: "image/id",
            size: 8,
            uploadedBy: {
              email: "admin@example.com",
              id: "admin-id",
              name: "Admin",
            },
          },
        });
      }
      return Response.json({
        assignedTo: "user/id",
        status: "open",
        updatedAt: "2026-08-25T12:00:00.000Z",
      });
    }) as typeof fetch;

    try {
      await updateAuditIssue("issue/id", { assignedTo: "user/id" });
      const file = new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
        "panel.png",
        { type: "image/png" },
      );
      await uploadAuditIssueImage("issue/id", file);
      await deleteAuditIssueImage("issue/id", "image/id");

      expect(requests).toHaveLength(3);
      expect(requests[0]).toMatchObject({
        init: {
          body: JSON.stringify({ assignedTo: "user/id" }),
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        },
        url: `${apiUrl}/api/audits/issues/issue%2Fid`,
      });
      expect(requests[1]).toMatchObject({
        init: {
          body: file,
          credentials: "include",
          headers: { "Content-Type": "image/png" },
          method: "POST",
        },
        url: `${apiUrl}/api/audits/issues/issue%2Fid/images?filename=panel.png`,
      });
      expect(requests[2]).toMatchObject({
        init: { credentials: "include", method: "DELETE" },
        url: `${apiUrl}/api/audits/issues/issue%2Fid/images/image%2Fid`,
      });
      expect(auditIssueImageUrl("issue/id", "image/id", "thumbnail")).toBe(
        `${apiUrl}/api/audits/issues/issue%2Fid/images/image%2Fid?variant=thumbnail`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves rate-limit responses and backs off across repeated 429s", async () => {
    const originalFetch = globalThis.fetch;
    const file = new File([new Uint8Array([1])], "panel.png", {
      type: "image/png",
    });
    const calls: string[] = [];
    const waits: number[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(input.toString());
      if (calls.length <= 3) {
        return Response.json(
          { error: "busy" },
          { headers: { "Retry-After": "1" }, status: 429 },
        );
      }
      return Response.json({ image: {} });
    }) as typeof fetch;

    try {
      const failures = await uploadIssueImagesSequentially(
        "issue/id",
        [file],
        uploadAuditIssueImage,
        async (milliseconds) => {
          waits.push(milliseconds);
        },
      );

      expect(failures).toEqual([]);
      expect(calls).toEqual([
        `${apiUrl}/api/audits/issues/issue%2Fid/images?filename=panel.png`,
        `${apiUrl}/api/audits/issues/issue%2Fid/images?filename=panel.png`,
        `${apiUrl}/api/audits/issues/issue%2Fid/images?filename=panel.png`,
        `${apiUrl}/api/audits/issues/issue%2Fid/images?filename=panel.png`,
      ]);
      expect(waits).toEqual([1_000, 2_000, 4_000]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops retrying an image after a bounded 429 backoff window", async () => {
    const file = new File([new Uint8Array([1])], "panel.png", {
      type: "image/png",
    });
    let calls = 0;
    const waits: number[] = [];
    const busy = new AuditApiError(
      "busy",
      new Response(null, { headers: { "Retry-After": "1" }, status: 429 }),
    );

    const failures = await uploadIssueImagesSequentially(
      "issue/id",
      [file],
      async () => {
        calls += 1;
        throw busy;
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    expect(failures).toEqual([busy]);
    expect(calls).toBe(10);
    expect(waits).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000, 10_000,
    ]);
  });
});

function exampleTemplate(): AuditTemplate {
  return {
    createdAt: "2026-08-24T12:00:00.000Z",
    currentVersion: 2,
    definition: {
      sections: [
        {
          id: "section-1",
          items: [
            {
              id: "item-1",
              prompt: "Question",
              required: true,
              responseType: "check",
            },
          ],
          title: "Section",
        },
      ],
      version: 1,
    },
    description: "Description",
    id: "template/id",
    name: "Shared form",
    savedAt: "2026-08-24T13:00:00.000Z",
    savedBy: {
      email: "admin@example.com",
      id: "admin-id",
      name: "Admin",
    },
    scope: "global",
    status: "draft",
    updatedAt: "2026-08-24T13:00:00.000Z",
    version: 2,
  };
}
