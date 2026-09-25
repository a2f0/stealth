import { describe, expect, it } from "bun:test";
import { apiUrl } from "./config";
import {
  contractDocumentUrl,
  contractFinalUrl,
  deleteContract,
  getContract,
  listContracts,
  remindContract,
  saveContractDraft,
  sendContract,
  uploadContract,
  voidContract,
} from "./contractsApi";

describe("contracts API", () => {
  it("addresses the contract endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        body: init?.body,
        method: init?.method ?? "GET",
        url: input.toString(),
      });
      expect(init?.credentials).toBe("include");
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ contract: { id: "c/1" }, contracts: [] });
    }) as typeof fetch;

    try {
      const draft = {
        dueDate: "2026-10-01",
        fields: [],
        message: "",
        recipients: [],
        reminderIntervalDays: 3,
        signingOrder: "parallel" as const,
        title: "Lease",
      };
      await listContracts();
      await uploadContract(new File(["%PDF-"], "lease.pdf"));
      await getContract("c/1");
      await saveContractDraft("c/1", draft);
      await sendContract("c/1");
      await remindContract("c/1");
      await voidContract("c/1", "Wrong terms");
      await deleteContract("c/1");
      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${apiUrl}/api/contracts`,
        `POST ${apiUrl}/api/contracts`,
        `GET ${apiUrl}/api/contracts/c%2F1`,
        `PUT ${apiUrl}/api/contracts/c%2F1/draft`,
        `POST ${apiUrl}/api/contracts/c%2F1/send`,
        `POST ${apiUrl}/api/contracts/c%2F1/remind`,
        `POST ${apiUrl}/api/contracts/c%2F1/void`,
        `DELETE ${apiUrl}/api/contracts/c%2F1`,
      ]);
      const form = requests[1]?.body as FormData;
      expect((form.get("file") as File).name).toBe("lease.pdf");
      expect(requests[3]?.body).toBe(JSON.stringify(draft));
      expect(requests[6]?.body).toBe(JSON.stringify({ reason: "Wrong terms" }));
      expect(contractDocumentUrl("c/1")).toBe(
        `${apiUrl}/api/contracts/c%2F1/document`,
      );
      expect(contractFinalUrl("c/1")).toBe(
        `${apiUrl}/api/contracts/c%2F1/final`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs a draft's saves in order and reads after them", async () => {
    const originalFetch = globalThis.fetch;
    const log: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls += 1;
      const call = calls;
      log.push(`start ${init?.method ?? "GET"}`);
      if (call === 1) await firstHeld;
      log.push(`end ${call}`);
      return Response.json({ contract: { id: "c1" } });
    }) as typeof fetch;
    try {
      const draft = {
        dueDate: null,
        fields: [],
        message: "",
        recipients: [],
        reminderIntervalDays: null,
        signingOrder: "parallel" as const,
        title: "Lease",
      };
      const first = saveContractDraft("c1", draft);
      const second = saveContractDraft("c1", { ...draft, title: "Lease v2" });
      const read = getContract("c1");
      await Bun.sleep(5);
      expect(log).toEqual(["start PUT"]);
      releaseFirst();
      await Promise.all([first, second, read]);
      expect(log).toEqual([
        "start PUT",
        "end 1",
        "start PUT",
        "end 2",
        "start GET",
        "end 3",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces the API's error message", async () => {
    const originalFetch = globalThis.fetch;
    let status = 400;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      status === 400
        ? Response.json({ error: "Add at least one signer." }, { status })
        : new Response("upstream failure", { status })) as typeof fetch;
    try {
      await expect(sendContract("c1")).rejects.toThrow(
        "Add at least one signer.",
      );
      status = 502;
      await expect(uploadContract(new File(["x"], "x.pdf"))).rejects.toThrow(
        "Request failed with status 502.",
      );
      await expect(deleteContract("c1")).rejects.toThrow(
        "Request failed with status 502.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
