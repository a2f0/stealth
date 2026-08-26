import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertTrackedCheckoutWithinLimits,
  materializeTrackedCheckout,
  parseTrackedTreeEntry,
  type TrackedCheckoutReader,
  trackedDestination,
} from "./materializeTrackedCheckout";

describe("materializeTrackedCheckout", () => {
  test("parses tracked blobs and rejects path traversal", () => {
    expect(
      parseTrackedTreeEntry(Buffer.from("100644 blob abc123 12\tsrc/a.ts")),
    ).toEqual({
      mode: "100644",
      type: "blob",
      oid: "abc123",
      size: 12,
      filePath: "src/a.ts",
    });
    expect(
      parseTrackedTreeEntry(
        Buffer.from("100644 blob def456 10\tsrc/line\nbreak.ts"),
      ),
    ).toEqual({
      filePath: "src/line\nbreak.ts",
      mode: "100644",
      oid: "def456",
      size: 10,
      type: "blob",
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
    let listedTreeish = "";
    const reader: TrackedCheckoutReader = {
      listTree: (_repositoryRoot, treeish) => {
        listedTreeish = treeish;
        return Buffer.from("120000 blob abc123 10\tlink\0");
      },
      readBlob: () => Buffer.from("../../.env"),
    };

    try {
      materializeTrackedCheckout("/unused", checkout, "head-1", reader);
      const target = path.join(checkout, "link");
      expect(listedTreeish).toBe("head-1");
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("../../.env");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("materializes a NUL-delimited path containing a newline", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-tool-newline-"));
    const checkout = path.join(root, "checkout");
    const filePath = "src/line\nbreak.ts";
    const reader: TrackedCheckoutReader = {
      listTree: () => Buffer.from(`100644 blob abc123 11\t${filePath}\0`),
      readBlob: () => Buffer.from("export {};\n"),
    };

    try {
      materializeTrackedCheckout("/unused", checkout, "HEAD", reader);
      expect(readFileSync(path.join(checkout, filePath), "utf8")).toBe(
        "export {};\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects cumulative file and byte limits before creating a checkout", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-tool-limits-"));
    const checkout = path.join(root, "checkout");
    let blobReads = 0;
    const reader: TrackedCheckoutReader = {
      listTree: () =>
        Buffer.from(
          "100644 blob abc123 6\tone.txt\0" + "100644 blob def456 6\ttwo.txt\0",
        ),
      readBlob: () => {
        blobReads += 1;
        return Buffer.from("123456");
      },
    };

    try {
      expect(() =>
        materializeTrackedCheckout("/unused", checkout, "HEAD", reader, {
          maxBytes: 10,
          maxFiles: 10,
        }),
      ).toThrow("materialization limit");
      expect(blobReads).toBe(0);
      expect(() => lstatSync(checkout)).toThrow();

      expect(() =>
        materializeTrackedCheckout("/unused", checkout, "HEAD", reader, {
          maxBytes: 100,
          maxFiles: 1,
        }),
      ).toThrow("2 files");
      expect(blobReads).toBe(0);
      expect(() => lstatSync(checkout)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("counts submodule marker bytes during checkout preflight", () => {
    const entry = parseTrackedTreeEntry(
      Buffer.from("160000 commit abc123 -\tdependency"),
    );
    expect(() =>
      assertTrackedCheckoutWithinLimits([entry], {
        maxBytes: 10,
        maxFiles: 1,
      }),
    ).toThrow("materialization limit");
  });

  test("rejects invalid UTF-8 and portable path collisions before writing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-tool-path-bytes-"));
    const checkout = path.join(root, "checkout");
    let blobReads = 0;
    const readBlob = () => {
      blobReads += 1;
      return Buffer.from("x");
    };
    const invalidReader: TrackedCheckoutReader = {
      listTree: () =>
        Buffer.concat([
          Buffer.from("100644 blob abc123 1\tinvalid-"),
          Buffer.from([0xff, 0]),
        ]),
      readBlob,
    };
    const collisionReader: TrackedCheckoutReader = {
      listTree: () =>
        Buffer.from(
          "100644 blob abc123 1\tsrc/caf\u00e9.ts\0" +
            "100644 blob def456 1\tsrc/cafe\u0301.ts\0",
        ),
      readBlob,
    };

    try {
      expect(() =>
        materializeTrackedCheckout("/unused", checkout, "HEAD", invalidReader),
      ).toThrow("not valid UTF-8");
      expect(() =>
        materializeTrackedCheckout(
          "/unused",
          checkout,
          "HEAD",
          collisionReader,
        ),
      ).toThrow("colliding paths");
      expect(blobReads).toBe(0);
      expect(() => lstatSync(checkout)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
