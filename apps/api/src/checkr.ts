import type { Bindings } from "./types";

interface CheckrCandidate {
  id: string;
}

interface CheckrInvitation {
  id: string;
  report_id: string | null;
  status: string;
}

interface CheckrReport {
  id: string;
  result: string | null;
  status: string;
}

export function checkrPackage(
  env: Bindings,
  kind: "background_check" | "credit_check",
) {
  return kind === "background_check"
    ? env.CHECKR_BACKGROUND_PACKAGE
    : env.CHECKR_CREDIT_PACKAGE;
}

export function checkrConfigured(
  env: Bindings,
  kind: "background_check" | "credit_check",
) {
  return Boolean(env.CHECKR_API_KEY && checkrPackage(env, kind));
}

export async function createCheckrCandidate(
  env: Bindings,
  email: string,
  requirementId: string,
) {
  const body = new URLSearchParams({ email, custom_id: requirementId });
  return checkrRequest<CheckrCandidate>(env, "/candidates", {
    body,
    headers: { "Idempotency-Key": requirementId },
    method: "POST",
  });
}

export async function createCheckrInvitation(
  env: Bindings,
  candidateId: string,
  packageSlug: string,
  state: string,
  city: string,
  requirementId: string,
) {
  const body = new URLSearchParams({
    candidate_id: candidateId,
    package: packageSlug,
    "work_locations[][country]": "US",
    "work_locations[][state]": state,
  });
  if (city) body.set("work_locations[][city]", city);
  return checkrRequest<CheckrInvitation>(env, "/invitations", {
    body,
    headers: { "Idempotency-Key": invitationKey(requirementId) },
    method: "POST",
  });
}

function invitationKey(requirementId: string) {
  const lastDigit = Number.parseInt(requirementId.slice(-1), 16);
  return `${requirementId.slice(0, -1)}${(lastDigit ^ 8).toString(16)}`;
}

export async function getCheckrInvitation(env: Bindings, id: string) {
  return checkrRequest<CheckrInvitation>(
    env,
    `/invitations/${encodeURIComponent(id)}`,
  );
}

export async function getCheckrReport(env: Bindings, id: string) {
  return checkrRequest<CheckrReport>(env, `/reports/${encodeURIComponent(id)}`);
}

async function checkrRequest<T>(
  env: Bindings,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!env.CHECKR_API_KEY) throw new Error("Checkr is not configured.");
  const host =
    env.CHECKR_ENV === "production"
      ? "https://api.checkr.com/v1"
      : "https://api.checkr-staging.com/v1";
  const response = await fetch(`${host}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${btoa(`${env.CHECKR_API_KEY}:`)}`,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      `Checkr request failed (${response.status}): ${payload?.message ?? payload?.error ?? "Please check the package and account settings."}`,
    );
  }
  return response.json() as Promise<T>;
}
