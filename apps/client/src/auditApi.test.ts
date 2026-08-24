import { describe, expect, it } from "bun:test";
import {
  type AuditTemplate,
  createAuditTemplate,
  getAuditTemplateVersion,
  listAuditTemplateVersions,
  updateAuditTemplate,
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
      ]);
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
