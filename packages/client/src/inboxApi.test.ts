import { describe, expect, it } from "bun:test";
import {
  deleteInboundEmail,
  getInboundEmail,
  inboundAttachmentUrl,
  listInboundEmails,
  restoreInboundEmail,
} from "./api";
import { apiUrl } from "./config";

describe("inbox API", () => {
  it("addresses the Trash lifecycle endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = input.toString();
      requests.push({ method: init?.method ?? "GET", url });
      expect(init?.credentials).toBe("include");
      if (url.endsWith("/restore")) {
        return Response.json({ emailId: "message/id" });
      }
      if (init?.method === "DELETE") {
        return Response.json({
          deletedAt: "2026-08-21T12:00:00.000Z",
          deletedByUserId: "user-id",
          emailId: "message/id",
        });
      }
      if (url.includes("message%2Fid")) {
        return Response.json({ email: {} });
      }
      return Response.json({ address: "upload@example.com", emails: [] });
    }) as typeof fetch;

    try {
      await listInboundEmails("trash");
      await getInboundEmail("message/id", "trash");
      await deleteInboundEmail("message/id");
      await restoreInboundEmail("message/id");
      expect(requests).toEqual([
        { method: "GET", url: `${apiUrl}/api/inbox?folder=trash` },
        {
          method: "GET",
          url: `${apiUrl}/api/inbox/message%2Fid?folder=trash`,
        },
        { method: "DELETE", url: `${apiUrl}/api/inbox/message%2Fid` },
        {
          method: "POST",
          url: `${apiUrl}/api/inbox/message%2Fid/restore`,
        },
      ]);
      expect(inboundAttachmentUrl("message/id", "attachment/id", "trash")).toBe(
        `${apiUrl}/api/inbox/message%2Fid/attachments/attachment%2Fid?folder=trash`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
