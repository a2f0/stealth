import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveTrustedExecutable } from "./trustedExecutable";

describe("resolveTrustedExecutable", () => {
  test("skips a PATH-shadowing executable inside the repository", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-tool-repository-"));
    const trustedRoot = mkdtempSync(path.join(tmpdir(), "agent-tool-runtime-"));
    const shadowDirectory = path.join(root, "bin");
    const trustedDirectory = path.join(trustedRoot, "bin");
    mkdirSync(shadowDirectory);
    mkdirSync(trustedDirectory);
    try {
      for (const name of ["codex", "claude"]) {
        const shadow = path.join(shadowDirectory, name);
        const trusted = path.join(trustedDirectory, name);
        writeFileSync(shadow, "#!/bin/sh\nexit 99\n");
        writeFileSync(trusted, "#!/bin/sh\nexit 0\n");
        chmodSync(shadow, 0o755);
        chmodSync(trusted, 0o755);

        const runtime = resolveTrustedExecutable(
          name,
          { PATH: [shadowDirectory, trustedDirectory].join(path.delimiter) },
          root,
        );
        expect(runtime?.executable).toBe(realpathSync(trusted));
        expect(runtime?.readablePaths).not.toContain(shadow);
        expect(
          resolveTrustedExecutable(name, { PATH: shadowDirectory }, root),
        ).toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(trustedRoot, { recursive: true, force: true });
    }
  });
});
