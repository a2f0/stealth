import { describe, expect, it } from "bun:test";
import {
  createLibraryFolder,
  deleteLibraryFolder,
  getLibraryFolder,
  linkInboundEmail,
  listLibraryFolders,
  listObjects,
  moveObject,
  renameLibraryFolder,
  unlinkInboundEmail,
  uploadObject,
} from "./api";
import { apiUrl } from "./config";
import { searchFinanceTransactions } from "./financeApi";

interface RecordedRequest {
  body: BodyInit | null | undefined;
  method: string;
  url: string;
}

describe("library and link API", () => {
  it("addresses folder, move, link, and search endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const requests: RecordedRequest[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        body: init?.body,
        method: init?.method ?? "GET",
        url: input.toString(),
      });
      expect(init?.credentials).toBe("include");
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({
        emails: [],
        folder: {},
        folders: [],
        link: {},
        object: {},
        objects: [],
        transactions: [],
      });
    }) as typeof fetch;

    try {
      await listObjects();
      await listObjects("folder/1");
      await uploadObject(new File(["x"], "a.txt"), "folder/1");
      await moveObject("object/1", null);
      await listLibraryFolders();
      await getLibraryFolder("folder/1");
      await createLibraryFolder("Taxes");
      await renameLibraryFolder("folder/1", "Receipts");
      await deleteLibraryFolder("folder/1");
      await linkInboundEmail("email/1", {
        targetId: "folder/1",
        targetType: "library_folder",
      });
      await unlinkInboundEmail("email/1", "link/1");
      await searchFinanceTransactions("  $42.75 ");
      await searchFinanceTransactions(" ");

      const folder = `${apiUrl}/api/library/folders/folder%2F1`;
      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${apiUrl}/api/objects`,
        `GET ${apiUrl}/api/objects?folder=folder%2F1`,
        `POST ${apiUrl}/api/objects`,
        `PATCH ${apiUrl}/api/objects/object%2F1`,
        `GET ${apiUrl}/api/library/folders`,
        `GET ${folder}`,
        `POST ${apiUrl}/api/library/folders`,
        `PATCH ${folder}`,
        `DELETE ${folder}`,
        `POST ${apiUrl}/api/inbox/email%2F1/links`,
        `DELETE ${apiUrl}/api/inbox/email%2F1/links/link%2F1`,
        `GET ${apiUrl}/api/finance/transactions?q=%2442.75`,
        `GET ${apiUrl}/api/finance/transactions`,
      ]);
      const upload = requests[2]?.body;
      expect(upload instanceof FormData && upload.get("folderId")).toBe(
        "folder/1",
      );
      expect(requests[3]?.body).toBe(JSON.stringify({ folderId: null }));
      expect(requests[9]?.body).toBe(
        JSON.stringify({ targetId: "folder/1", targetType: "library_folder" }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
