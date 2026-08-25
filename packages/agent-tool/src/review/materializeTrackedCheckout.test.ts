import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  materializeTrackedCheckout,
  parseTrackedTreeEntry,
  type TrackedCheckoutReader,
  trackedDestination,
} from "./materializeTrackedCheckout";

describe("materializeTrackedCheckout", () => {
  test("parses tracked blobs and rejects path traversal", () => {
    expect(parseTrackedTreeEntry("100644 blob abc123\tsrc/a.ts")).toEqual({
      mode: "100644",
      type: "blob",
      oid: "abc123",
      filePath: "src/a.ts",
    });
    expect(() => trackedDestination("/tmp/review", "../.env")).toThrow(
      "Unsafe tracked path",
    );
    expect(() => trackedDestination("/tmp/review", "a\\..\\.env")).toThrow(
      "Unsafe tracked path",
    );
  });

  test("writes committed symlinks as inert regular files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-tool-checkout-"));
    const checkout = path.join(root, "checkout");
    const reader: TrackedCheckoutReader = {
      listTree: () => "120000 blob abc123\tlink\0",
      readBlob: () => Buffer.from("../../.env"),
    };

    try {
      materializeTrackedCheckout("/unused", checkout, reader);
      const target = path.join(checkout, "link");
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("../../.env");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
