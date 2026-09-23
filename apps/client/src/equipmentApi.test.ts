import { describe, expect, it } from "bun:test";
import { apiUrl } from "./config";
import {
  createEquipment,
  deleteEquipment,
  getEquipment,
  listEquipment,
  updateEquipment,
} from "./equipmentApi";

describe("equipment API", () => {
  it("addresses the equipment endpoints", async () => {
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
      return Response.json({ equipment: { id: "item/1" } });
    }) as typeof fetch;

    try {
      const input = {
        assigneeId: null,
        make: "Apple",
        model: "MacBook Pro",
        purchaseDate: "2026-03-01",
        serialNumber: null,
        type: "computer",
      };
      await listEquipment();
      await getEquipment("item/1");
      await createEquipment(input);
      await updateEquipment("item/1", { assigneeId: "user-1" });
      await deleteEquipment("item/1");
      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${apiUrl}/api/equipment`,
        `GET ${apiUrl}/api/equipment/item%2F1`,
        `POST ${apiUrl}/api/equipment`,
        `PATCH ${apiUrl}/api/equipment/item%2F1`,
        `DELETE ${apiUrl}/api/equipment/item%2F1`,
      ]);
      expect(requests[2]?.body).toBe(JSON.stringify(input));
      expect(requests[3]?.body).toBe(JSON.stringify({ assigneeId: "user-1" }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("equipment API errors", () => {
  it("sends JSON and surfaces the API's error message", async () => {
    const originalFetch = globalThis.fetch;
    const headers: unknown[] = [];
    let status = 400;
    globalThis.fetch = (async (_input, init) => {
      headers.push(init?.headers);
      return status === 400
        ? Response.json({ error: "Equipment details are invalid." }, { status })
        : new Response("upstream failure", { status });
    }) as typeof fetch;
    try {
      await expect(updateEquipment("item-1", { make: "" })).rejects.toThrow(
        "Equipment details are invalid.",
      );
      expect(headers[0]).toEqual({ "Content-Type": "application/json" });
      status = 502;
      await expect(listEquipment()).rejects.toThrow(
        "Request failed with status 502.",
      );
      await expect(deleteEquipment("item-1")).rejects.toThrow(
        "Request failed with status 502.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
