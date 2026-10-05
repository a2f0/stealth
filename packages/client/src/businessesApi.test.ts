import { describe, expect, it } from "bun:test";
import { getBusiness, updateBusiness } from "./businessesApi";
import { apiUrl } from "./config";

describe("businesses API", () => {
  it("loads an encoded business route", async () => {
    const originalFetch = globalThis.fetch;
    let url: string | undefined;
    globalThis.fetch = (async (input, init) => {
      url = input.toString();
      expect(init?.credentials).toBe("include");
      return Response.json({ business: { id: "business/id", name: "Acme" } });
    }) as typeof fetch;
    try {
      expect((await getBusiness("business/id")).business.name).toBe("Acme");
      expect(url).toBe(`${apiUrl}/api/businesses/business%2Fid`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
        city: "New York",
        duns: "12-345-6789",
        ein: null,
        incorporationDate: "2026-08-22",
        name: "Acme",
        state: "NY",
        streetAddress: "123 Main Street",
        zip: "10001",
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
