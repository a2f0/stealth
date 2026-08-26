import { commitHeaderMaxLength, commitTypes } from "./commitPolicy";

const allowedTypes = new Set<string>(commitTypes);
const conventionalHeader = /^(\w*)(?:\((.*)\))?!?: (.*)$/;
const startsWithUppercaseLetter = /^[\p{Lu}\p{Lt}]/u;

/**
 * Validate the header-only subset of the repository's commitlint policy.
 *
 * This deliberately does not launch commitlint or load the checkout's
 * executable TypeScript config: open/merge runs with GitHub credentials, and a
 * feature branch must not be able to execute code before those operations. The
 * trusted agent-tool snapshot carries the shared type and length policy, while
 * these checks mirror config-conventional's header parser and enabled header
 * rules.
 */
export function validateCommitSubject(_rootDir: string, subject: string): void {
  const problems: string[] = [];
  if (subject.trim() !== subject) problems.push("header must be trimmed");
  if (subject.length > commitHeaderMaxLength) {
    problems.push(`header must not exceed ${commitHeaderMaxLength} characters`);
  }
  if (subject.includes("\n") || subject.includes("\r")) {
    problems.push("header must be one line");
  }
  const parsed = conventionalHeader.exec(subject);
  if (parsed === null) {
    problems.push("header must use conventional-commit syntax");
  } else {
    const [, type = "", , parsedSubject = ""] = parsed;
    if (!allowedTypes.has(type)) {
      problems.push(`type must be one of: ${commitTypes.join(", ")}`);
    }
    if (parsedSubject.length === 0) problems.push("subject must not be empty");
    if (parsedSubject.endsWith(".")) {
      problems.push("subject must not end with a period");
    }
    if (startsWithUppercaseLetter.test(parsedSubject)) {
      problems.push("subject must begin with lower-case text");
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Commit subject rejected by commitlint policy:\n${problems.join("\n")}`,
    );
  }
}
