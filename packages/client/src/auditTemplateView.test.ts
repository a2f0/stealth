import { describe, expect, it } from "bun:test";
import {
  defaultAuditTemplateView,
  readAuditTemplateView,
  storeAuditTemplateView,
} from "./auditTemplateView";

describe("audit template view", () => {
  it("defaults to the grid when nothing usable is stored", () => {
    expect(defaultAuditTemplateView).toBe("grid");
    expect(readAuditTemplateView({ getItem: () => null })).toBe("grid");
    expect(readAuditTemplateView({ getItem: () => "table" })).toBe("grid");
    expect(
      readAuditTemplateView({
        getItem: () => {
          throw new Error("Storage is disabled.");
        },
      }),
    ).toBe("grid");
  });

  it("loads and stores the chosen view", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    storeAuditTemplateView("list", storage);
    expect([...values.values()]).toEqual(["list"]);
    expect(readAuditTemplateView(storage)).toBe("list");
    storeAuditTemplateView("grid", storage);
    expect(readAuditTemplateView(storage)).toBe("grid");
  });

  it("ignores storage that refuses writes", () => {
    expect(() =>
      storeAuditTemplateView("list", {
        setItem: () => {
          throw new Error("Quota exceeded.");
        },
      }),
    ).not.toThrow();
  });
});
