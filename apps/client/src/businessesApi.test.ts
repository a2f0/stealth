import { describe, expect, it } from "bun:test";
import { updateBusiness } from "./businessesApi";
import { apiUrl } from "./config";

describe("businesses API", () => {
  it("updates the encoded business route", async () => {
    const originalFetch = globalThis.fetch;
    let request:
      | { body: string | undefined; method: string; url: string }
      | undefined;
    globalThis.fetch = (async (input, init) => {
      request = {
        body: init?.body?.toString(),
        method: init?.method ?? "GET",
        url: input.toString(),
      };
      expect(init?.credentials).toBe("include");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      return Response.json({
        business: { ein: null, id: "business/id", name: "Acme" },
      });
    }) as typeof fetch;

    try {
      const business = {
        ein: null,
        incorporationDate: "2026-08-22",
        name: "Acme",
        streetAddress: "123 Main Street",
      };
      await updateBusiness("business/id", business);
      expect(request).toEqual({
        body: JSON.stringify(business),
        method: "PATCH",
        url: `${apiUrl}/api/businesses/business%2Fid`,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
