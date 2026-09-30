/** The packages whose version ship-pr keeps one patch ahead of the base. */
export const VERSIONED_PACKAGES = ["packages/api", "packages/client"] as const;

export function manifestPath(packageDir: string): string {
  return `${packageDir}/package.json`;
}

export function isVersionedManifest(filePath: string): boolean {
  return VERSIONED_PACKAGES.some(
    (packageDir) => manifestPath(packageDir) === filePath,
  );
}

type Semver = readonly [major: number, minor: number, patch: number];

function parseSemver(version: string): Semver {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (match === null) {
    throw new Error(`"${version}" is not a plain major.minor.patch version.`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function bumpPatch(version: string): string {
  const [major, minor, patch] = parseSemver(version);
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Whether `version` is a deliberate major or minor release over `base`, which
 * the patch bump must not overwrite.
 */
export function isReleaseBump(version: string, base: string): boolean {
  const [major, minor] = parseSemver(version);
  const [baseMajor, baseMinor] = parseSemver(base);
  return major > baseMajor || (major === baseMajor && minor > baseMinor);
}

/** The top-level `version` of a package.json source. */
export function readVersion(manifest: string): string {
  const parsed: unknown = JSON.parse(manifest);
  const version =
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, "version")
      : undefined;
  if (typeof version !== "string") {
    throw new Error("package.json has no string version.");
  }
  return version;
}

/**
 * The package.json source with its top-level `version` replaced, leaving every
 * other byte alone so the diff is the one line.
 */
export function withVersion(manifest: string, version: string): string {
  const current = readVersion(manifest).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const field = new RegExp(`("version"\\s*:\\s*")${current}(")`);
  const updated = manifest.replace(
    field,
    (_match, open: string, close: string) => `${open}${version}${close}`,
  );
  if (readVersion(updated) !== version) {
    throw new Error("could not rewrite the package.json version field.");
  }
  return updated;
}
