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
      await updateBusiness("business/id", { ein: null, name: "Acme" });
      expect(request).toEqual({
        body: JSON.stringify({ ein: null, name: "Acme" }),
        method: "PATCH",
        url: `${apiUrl}/api/businesses/business%2Fid`,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
