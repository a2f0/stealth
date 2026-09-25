import { describe, expect, it } from "bun:test";
import { apiUrl } from "./config";
import {
  declineContract,
  getSigning,
  signContract,
  signingDocumentUrl,
  signingFinalUrl,
} from "./signingApi";

describe("signing API", () => {
  it("authorizes with the token alone, never cookies", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      body: unknown;
      headers: unknown;
      method: string;
      url: string;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        body: init?.body,
        headers: init?.headers,
        method: init?.method ?? "GET",
        url: input.toString(),
      });
      expect(init?.credentials).toBe("omit");
      return Response.json({ status: "signed" });
    }) as typeof fetch;

    try {
      const signature = {
        consent: true,
        signature: "data:image/png;base64,AA==",
        values: { f1: "Acme" },
      };
      await getSigning("tok");
      await signContract("tok", signature);
      await declineContract("tok", "Wrong rate");
      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${apiUrl}/api/signing/tok`,
        `POST ${apiUrl}/api/signing/tok/sign`,
        `POST ${apiUrl}/api/signing/tok/decline`,
      ]);
      expect(requests[0]?.headers).toBeUndefined();
      expect(requests[1]?.headers).toEqual({
        "Content-Type": "application/json",
      });
      expect(requests[1]?.body).toBe(JSON.stringify(signature));
      expect(requests[2]?.body).toBe(JSON.stringify({ reason: "Wrong rate" }));
      expect(signingDocumentUrl("tok")).toBe(
        `${apiUrl}/api/signing/tok/document`,
      );
      expect(signingFinalUrl("tok")).toBe(`${apiUrl}/api/signing/tok/final`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces the API's error message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      Response.json(
        { error: "This signing link is no longer valid." },
        { status: 404 },
      )) as typeof fetch;
    try {
      await expect(getSigning("tok")).rejects.toThrow(
        "This signing link is no longer valid.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
