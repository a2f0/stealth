import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MAX_BUFFER_BYTES } from "../git/prContext";

interface TrackedTreeEntry {
  readonly mode: string;
  readonly type: "blob" | "commit";
  readonly oid: string;
  readonly filePath: string;
}

export interface TrackedCheckoutReader {
  readonly listTree: (repositoryRoot: string, treeish: string) => string;
  readonly readBlob: (repositoryRoot: string, oid: string) => Buffer;
}

const gitReader: TrackedCheckoutReader = {
  listTree(repositoryRoot, treeish) {
    return execFileSync(
      "git",
      ["-C", repositoryRoot, "ls-tree", "-rz", "--full-tree", "-r", treeish],
      { encoding: "utf8", maxBuffer: MAX_BUFFER_BYTES },
    );
  },
  readBlob(repositoryRoot, oid) {
    return execFileSync(
      "git",
      ["-C", repositoryRoot, "cat-file", "blob", oid],
      {
        maxBuffer: MAX_BUFFER_BYTES,
      },
    );
  },
};

/** Parse one NUL-delimited `git ls-tree` record. */
export function parseTrackedTreeEntry(record: string): TrackedTreeEntry {
  const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]+)\t(.+)$/.exec(record);
  if (match === null) {
    throw new Error(
      `Could not parse tracked tree entry: ${JSON.stringify(record)}`,
    );
  }
  return {
    mode: match[1] ?? "",
    type: (match[2] ?? "") as "blob" | "commit",
    oid: match[3] ?? "",
    filePath: match[4] ?? "",
  };
}

/**
 * Resolve a Git path beneath `checkoutRoot`, rejecting traversal and paths that
 * become separators on Windows. Git normally forbids these shapes; checking
 * again keeps this extraction boundary independent of repository integrity.
 */
export function trackedDestination(
  checkoutRoot: string,
  filePath: string,
): string {
  const parts = filePath.split("/");
  if (
    filePath.length === 0 ||
    filePath.includes("\\") ||
    path.posix.isAbsolute(filePath) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe tracked path: ${JSON.stringify(filePath)}`);
  }

  const root = path.resolve(checkoutRoot);
  const destination = path.resolve(root, ...parts);
  if (!destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Tracked path escaped checkout: ${JSON.stringify(filePath)}`,
    );
  }
  return destination;
}

/**
 * Materialize exactly the blobs committed at `treeish` into a fresh review
 * tree.
 * This deliberately does not use checkout/archive extraction: a committed
 * symlink is written as an inert regular file containing its target, so it can
 * never redirect a later write or read outside the isolated tree. Submodules
 * are represented by a regular marker file and are never initialized.
 */
export function materializeTrackedCheckout(
  repositoryRoot: string,
  checkoutRoot: string,
  treeish = "HEAD",
  reader: TrackedCheckoutReader = gitReader,
): void {
  mkdirSync(checkoutRoot, { recursive: true });
  const records = reader
    .listTree(repositoryRoot, treeish)
    .split("\0")
    .filter(Boolean);

  for (const record of records) {
    const entry = parseTrackedTreeEntry(record);
    const destination = trackedDestination(checkoutRoot, entry.filePath);
    mkdirSync(path.dirname(destination), { recursive: true });

    if (entry.type === "commit") {
      writeFileSync(destination, `submodule ${entry.oid}\n`, { mode: 0o644 });
      continue;
    }

    const contents = reader.readBlob(repositoryRoot, entry.oid);
    // Mode 120000 is a Git symlink. Always materialize it as a regular file.
    const executable = entry.mode === "100755";
    writeFileSync(destination, contents, { mode: executable ? 0o755 : 0o644 });
    chmodSync(destination, executable ? 0o755 : 0o644);
  }
}
