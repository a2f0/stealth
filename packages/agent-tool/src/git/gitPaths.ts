/** Split Git's byte-oriented `-z` output without lossy string decoding. */
export function splitNulDelimitedGitOutput(
  output: Buffer,
  description: string,
): Buffer[] {
  if (output.byteLength === 0) return [];
  if (output.at(-1) !== 0) {
    throw new Error(`${description} was not NUL-terminated.`);
  }

  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    if (output[index] !== 0) continue;
    if (index === start) {
      throw new Error(`${description} contained an empty path record.`);
    }
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  return records;
}

/** Decode a Git path only when its original bytes survive a UTF-8 round trip. */
export function decodeGitPath(pathBytes: Buffer, description: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
  } catch {
    throw new Error(`${description} is not valid UTF-8.`);
  }
  if (!Buffer.from(decoded, "utf8").equals(pathBytes)) {
    throw new Error(`${description} does not round-trip through UTF-8.`);
  }
  return decoded;
}

function portablePathKey(filePath: string): string {
  return filePath
    .split("/")
    .map((part) => part.normalize("NFD").toLowerCase())
    .join("/");
}

/** Reject paths that can overwrite one another on common local filesystems. */
export function assertNoMaterializedPathCollisions(
  filePaths: readonly string[],
  description: string,
): void {
  const files = new Set<string>();
  const directories = new Set<string>();

  for (const filePath of filePaths) {
    const key = portablePathKey(filePath);
    if (files.has(key) || directories.has(key)) {
      throw new Error(`${description} contains colliding paths.`);
    }

    const parts = key.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join("/");
      if (files.has(parent)) {
        throw new Error(`${description} contains colliding paths.`);
      }
      directories.add(parent);
    }
    files.add(key);
  }
}
