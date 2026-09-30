import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  bumpPatch,
  isReleaseBump,
  manifestPath,
  readVersion,
  VERSIONED_PACKAGES,
  withVersion,
} from "./packageVersion";
import {
  assertRegularFile,
  showFile,
  trustedVersionGit,
  type VersionGit,
} from "./versionGit";

interface VersionPlan {
  readonly manifest: string;
  readonly baseVersion: string;
  readonly headVersion: string;
  readonly targetVersion: string;
}

function resolveBaseCommit(
  git: VersionGit,
  rootDir: string,
  baseOid: string | undefined,
): string {
  const oid = baseOid?.trim() ?? "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(oid)) {
    throw new Error("the base must be a full Git OID.");
  }
  return git.run(rootDir, ["rev-parse", "--verify", `${oid}^{commit}`]).trim();
}

/**
 * Whether the branch changes the package, counting its manifest only for edits
 * beyond the version field.
 */
function packageChanged(
  git: VersionGit,
  rootDir: string,
  mergeBase: string,
  packageDir: string,
  headManifest: string,
): boolean {
  const manifest = manifestPath(packageDir);
  const changed = git
    .run(rootDir, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      mergeBase,
      "HEAD",
      "--",
      packageDir,
    ])
    .split("\0")
    .filter(Boolean);
  if (changed.some((file) => file !== manifest)) {
    return true;
  }
  if (!changed.includes(manifest)) {
    return false;
  }
  const mergeBaseManifest = showFile(git, rootDir, mergeBase, manifest);
  if (mergeBaseManifest === null) {
    return true;
  }
  const version = readVersion(headManifest);
  return withVersion(mergeBaseManifest, version) !== headManifest;
}

/**
 * The version each package should carry at HEAD to merge onto `baseOid`: one
 * patch past the base when the branch changes the package, the base's own
 * version when it does not, and a deliberate major or minor bump left alone.
 */
export function planVersions(
  rootDir: string,
  baseOid: string | undefined,
  git: VersionGit = trustedVersionGit,
): VersionPlan[] {
  const baseCommit = resolveBaseCommit(git, rootDir, baseOid);
  const mergeBase = git.run(rootDir, ["merge-base", baseCommit, "HEAD"]).trim();
  const plans: VersionPlan[] = [];
  for (const packageDir of VERSIONED_PACKAGES) {
    const manifest = manifestPath(packageDir);
    const baseManifest = showFile(git, rootDir, baseCommit, manifest);
    const headManifest = showFile(git, rootDir, "HEAD", manifest);
    if (baseManifest === null || headManifest === null) {
      continue;
    }
    const baseVersion = readVersion(baseManifest);
    const headVersion = readVersion(headManifest);
    let targetVersion = baseVersion;
    if (isReleaseBump(headVersion, baseVersion)) {
      targetVersion = headVersion;
    } else if (
      packageChanged(git, rootDir, mergeBase, packageDir, headManifest)
    ) {
      targetVersion = bumpPatch(baseVersion);
    }
    plans.push({ manifest, baseVersion, headVersion, targetVersion });
  }
  return plans;
}

function describePlan(plan: VersionPlan): string {
  return `${plan.manifest}: ${plan.headVersion} -> ${plan.targetVersion} (base ${plan.baseVersion})`;
}

/**
 * Rewrite each versioned package.json whose HEAD version is not its target,
 * printing the rewritten paths on stdout for the caller to commit.
 */
export function bumpVersions(
  rootDir: string,
  baseOid?: string,
  git: VersionGit = trustedVersionGit,
): number {
  const pending = planVersions(rootDir, baseOid, git).filter(
    (plan) => plan.headVersion !== plan.targetVersion,
  );
  const rewrites = pending.map((plan) => {
    const file = path.join(rootDir, plan.manifest);
    const committed = showFile(git, rootDir, "HEAD", plan.manifest) ?? "";
    assertRegularFile(file, plan.manifest);
    // Staged edits count too: the caller's commit would otherwise carry them.
    const status = git.run(rootDir, [
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--",
      plan.manifest,
    ]);
    if (status !== "" || readFileSync(file, "utf8") !== committed) {
      throw new Error(
        `${plan.manifest} has uncommitted changes; commit or discard them first.`,
      );
    }
    return { file, plan, source: withVersion(committed, plan.targetVersion) };
  });
  for (const { file, plan, source } of rewrites) {
    writeFileSync(file, source);
    process.stderr.write(`${describePlan(plan)}\n`);
    process.stdout.write(`${plan.manifest}\n`);
  }
  return 0;
}

/** Exit non-zero when a versioned package at HEAD is not at its target. */
export function checkVersions(
  rootDir: string,
  baseOid?: string,
  git: VersionGit = trustedVersionGit,
): number {
  const stale = planVersions(rootDir, baseOid, git).filter(
    (plan) => plan.headVersion !== plan.targetVersion,
  );
  for (const plan of stale) {
    process.stderr.write(`Version needs a bump: ${describePlan(plan)}\n`);
  }
  return stale.length === 0 ? 0 : 1;
}
