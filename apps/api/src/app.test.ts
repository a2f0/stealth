import { describe, expect, it } from "bun:test";
import { app } from "./app";
import type { Bindings } from "./types";

describe("api", () => {
  it("reports its health", async () => {
    const response = await app.request("/health", undefined, {} as Bindings);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("returns a JSON 404", async () => {
    const response = await app.request("/missing", undefined, {} as Bindings);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"Not found."}');
  });
});
