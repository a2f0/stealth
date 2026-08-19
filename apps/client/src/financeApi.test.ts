import { describe, expect, it } from "bun:test";
import { apiUrl } from "./config";
import { getFinanceData } from "./financeApi";

describe("finance API", () => {
  it("loads the listing from the mounted route without a trailing slash", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl: string | undefined;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = input.toString();
      expect(init?.credentials).toBe("include");
      return Response.json({
        accounts: [],
        configured: true,
        connections: [],
        transactions: [],
      });
    }) as typeof fetch;

    try {
      await getFinanceData();
      expect(requestedUrl).toBe(`${apiUrl}/api/finance`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
