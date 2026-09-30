import { describe, expect, test } from "bun:test";

import {
  bumpPatch,
  isReleaseBump,
  isVersionedManifest,
  readVersion,
  withVersion,
} from "./packageVersion";

const manifest = `{
  "name": "demo",
  "version": "0.1.0",
  "overrides": {
    "thing": { "version": "0.1.0" }
  }
}
`;

describe("packageVersion", () => {
  test("bumps only the patch", () => {
    expect(bumpPatch("0.1.0")).toBe("0.1.1");
    expect(bumpPatch("1.0.9")).toBe("1.0.10");
  });

  test("rejects versions that are not plain major.minor.patch", () => {
    expect(() => bumpPatch("1.0.0-beta.1")).toThrow("not a plain");
    expect(() => bumpPatch("01.0.0")).toThrow("not a plain");
  });

  test("treats a major or minor increase as a deliberate release", () => {
    expect(isReleaseBump("0.2.0", "0.1.7")).toBe(true);
    expect(isReleaseBump("1.0.0", "0.1.7")).toBe(true);
    expect(isReleaseBump("0.1.9", "0.1.7")).toBe(false);
    expect(isReleaseBump("0.1.7", "0.1.7")).toBe(false);
  });

  test("rewrites only the top-level version line", () => {
    const updated = withVersion(manifest, "0.1.1");
    expect(readVersion(updated)).toBe("0.1.1");
    expect(updated).toBe(
      manifest.replace('"version": "0.1.0"', '"version": "0.1.1"'),
    );
  });

  test("matches a current version holding regex metacharacters literally", () => {
    const build = `{"name": "demo", "version": "1.0.0+build"}`;
    expect(readVersion(withVersion(build, "1.0.1"))).toBe("1.0.1");
    const lookalike = `{"x": {"version": "1x0x0"}, "version": "1.0.0"}`;
    expect(withVersion(lookalike, "$&")).toBe(
      `{"x": {"version": "1x0x0"}, "version": "$&"}`,
    );
  });

  test("refuses to rewrite a nested version that comes first", () => {
    const nestedFirst = `{"overrides": {"version": "1.0.0"}, "version": "1.0.0"}`;
    expect(() => withVersion(nestedFirst, "1.0.1")).toThrow(
      "could not rewrite",
    );
  });

  test("names the api and client manifests as versioned", () => {
    expect(isVersionedManifest("packages/api/package.json")).toBe(true);
    expect(isVersionedManifest("packages/client/package.json")).toBe(true);
    expect(isVersionedManifest("packages/ui/package.json")).toBe(false);
    expect(isVersionedManifest("packages/agent-tool/package.json")).toBe(false);
  });
});
