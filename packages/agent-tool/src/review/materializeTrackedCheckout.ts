import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MAX_BUFFER_BYTES } from "../git/prContext";
import { toolEnvironment, toolExecutable } from "../process/trustedTooling";

interface TrackedTreeEntry {
  readonly mode: string;
  readonly type: "blob" | "commit";
  readonly oid: string;
  readonly size: number | null;
  readonly filePath: string;
}

interface TrackedCheckoutLimits {
  readonly maxBytes: number;
  readonly maxFiles: number;
}

const DEFAULT_TRACKED_CHECKOUT_LIMITS: TrackedCheckoutLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxFiles: 20_000,
};

export interface TrackedCheckoutReader {
  readonly listTree: (repositoryRoot: string, treeish: string) => string;
  readonly readBlob: (repositoryRoot: string, oid: string) => Buffer;
}

const gitReader: TrackedCheckoutReader = {
  listTree(repositoryRoot, treeish) {
    return execFileSync(
      toolExecutable("git"),
      ["-C", repositoryRoot, "ls-tree", "-rzl", "--full-tree", "-r", treeish],
      {
        encoding: "utf8",
        env: toolEnvironment(),
        maxBuffer: MAX_BUFFER_BYTES,
      },
    );
  },
  readBlob(repositoryRoot, oid) {
    return execFileSync(
      toolExecutable("git"),
      ["-C", repositoryRoot, "cat-file", "blob", oid],
      {
        env: toolEnvironment(),
        maxBuffer: MAX_BUFFER_BYTES,
      },
    );
  },
};

/** Parse one NUL-delimited `git ls-tree` record. */
export function parseTrackedTreeEntry(record: string): TrackedTreeEntry {
  const separator = record.indexOf("\t");
  const header = separator < 0 ? record : record.slice(0, separator);
  const filePath = separator < 0 ? "" : record.slice(separator + 1);
  const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]+) +([0-9-]+)$/.exec(
    header,
  );
  if (match === null) {
    throw new Error(
      `Could not parse tracked tree entry: ${JSON.stringify(record)}`,
    );
  }
  const type = (match[2] ?? "") as "blob" | "commit";
  const rawSize = match[4] ?? "";
  const size = rawSize === "-" ? null : Number(rawSize);
  if (
    (type === "blob" &&
      (size === null || !Number.isSafeInteger(size) || size < 0)) ||
    (type === "commit" && size !== null)
  ) {
    throw new Error(`Invalid tracked object size: ${JSON.stringify(record)}`);
  }
  return {
    mode: match[1] ?? "",
    type,
    oid: match[3] ?? "",
    size,
    filePath,
  };
}

function entryMaterializedBytes(entry: TrackedTreeEntry): number {
  return entry.type === "blob"
    ? (entry.size ?? 0)
    : Buffer.byteLength(`submodule ${entry.oid}\n`);
}

export function assertTrackedCheckoutWithinLimits(
  entries: readonly TrackedTreeEntry[],
  limits: TrackedCheckoutLimits = DEFAULT_TRACKED_CHECKOUT_LIMITS,
): void {
  if (entries.length > limits.maxFiles) {
    throw new Error(
      `Tracked checkout contains ${entries.length} files; limit is ${limits.maxFiles}.`,
    );
  }

  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += entryMaterializedBytes(entry);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBytes) {
      throw new Error(
        `Tracked checkout exceeds the ${limits.maxBytes}-byte materialization limit.`,
      );
    }
  }
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
  limits: TrackedCheckoutLimits = DEFAULT_TRACKED_CHECKOUT_LIMITS,
): void {
  const entries = reader
    .listTree(repositoryRoot, treeish)
    .split("\0")
    .filter(Boolean)
    .map(parseTrackedTreeEntry);

  for (const entry of entries) {
    trackedDestination(checkoutRoot, entry.filePath);
  }
  assertTrackedCheckoutWithinLimits(entries, limits);
  mkdirSync(checkoutRoot, { recursive: true });

  for (const entry of entries) {
    const destination = trackedDestination(checkoutRoot, entry.filePath);
    mkdirSync(path.dirname(destination), { recursive: true });

    if (entry.type === "commit") {
      writeFileSync(destination, `submodule ${entry.oid}\n`, { mode: 0o644 });
      continue;
    }

    const contents = reader.readBlob(repositoryRoot, entry.oid);
    if (contents.byteLength !== entry.size) {
      throw new Error(
        `Tracked blob size changed while materializing ${JSON.stringify(entry.filePath)}.`,
      );
    }
    // Mode 120000 is a Git symlink. Always materialize it as a regular file.
    const executable = entry.mode === "100755";
    writeFileSync(destination, contents, { mode: executable ? 0o755 : 0o644 });
    chmodSync(destination, executable ? 0o755 : 0o644);
  }
}
