import { describe, expect, it } from "bun:test";
import {
  type AuditTemplate,
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
      if (init?.body instanceof FormData) {
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
      expect(requests[1]?.init?.body).toBeInstanceOf(FormData);
      expect(requests[1]?.init?.headers).toBeUndefined();
      const form = requests[1]?.init?.body as FormData;
      expect((form.get("file") as File).name).toBe("panel.png");
      expect(requests[1]).toMatchObject({
        init: { credentials: "include", method: "POST" },
        url: `${apiUrl}/api/audits/issues/issue%2Fid/images`,
      });
      expect(requests[2]).toMatchObject({
        init: { credentials: "include", method: "DELETE" },
        url: `${apiUrl}/api/audits/issues/issue%2Fid/images/image%2Fid`,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
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
