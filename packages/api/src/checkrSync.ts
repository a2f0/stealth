import type { Context } from "hono";
import { getCheckrReport, verifyCheckrWebhook } from "./checkr";
import {
  type CheckrScreeningRow,
  refreshCheckrScreening,
} from "./employeeForms";
import type { Bindings } from "./types";
import { readWebhookPayload } from "./webhookPayload";

const maxCheckrWebhookBytes = 1024 * 1024;
const screeningRefreshLimit = 24;
// Checkr calls can take several seconds each, so refresh a few at a time.
const screeningRefreshConcurrency = 4;

interface CheckrEventSubject {
  candidateId: string | null;
  id: string;
  kind: "invitation" | "report";
}

// Checkr posts invitation and report events here. A verified event is
// acknowledged at once, as Checkr asks, and then only triggers a refresh from
// the Checkr API, so duplicate or out-of-order deliveries settle on the current
// state. The hourly refresh below covers events whose refresh fails.
export async function handleCheckrWebhook(
  context: Context<{ Bindings: Bindings }>,
) {
  const apiKey = context.env.CHECKR_API_KEY;
  if (!apiKey) {
    console.error("Checkr webhook verification is not configured.");
    return context.json({ error: "Webhook verification is unavailable." }, 503);
  }
  const payload = await readWebhookPayload(
    context.req.raw,
    maxCheckrWebhookBytes,
  );
  if (payload === null) {
    return context.json({ error: "Webhook payload is too large." }, 413);
  }
  const verified = await verifyCheckrWebhook(
    payload,
    context.req.header("x-checkr-signature"),
    apiKey,
  );
  if (!verified) {
    return context.json({ error: "Webhook signature is invalid." }, 400);
  }
  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return context.json({ error: "Webhook payload is invalid." }, 400);
  }
  const subject = checkrEventSubject(event);
  if (subject === null) {
    return context.json({ error: "Webhook event is invalid." }, 400);
  }
  if (subject !== "ignored") {
    context.executionCtx.waitUntil(
      refreshEventScreenings(context.env, subject).catch((cause) => {
        console.error("Could not apply a Checkr webhook event.", cause);
      }),
    );
  }
  return context.json({ received: true });
}

// Safety net for missed webhooks: re-reads the least recently updated
// screenings that Checkr has not finished.
export async function refreshActiveCheckrScreenings(env: Bindings) {
  if (!env.CHECKR_API_KEY) return { refreshed: 0, skipped: true };
  const { results } = await env.DB.prepare(
    `SELECT id, organization_id, status, checkr_invitation_id,
            checkr_report_id, checkr_invitation_status,
            checkr_refresh_revision
     FROM employee_requirements
     WHERE checkr_invitation_id IS NOT NULL AND status <> 'complete'
       AND (checkr_invitation_status IS NULL OR checkr_invitation_status NOT IN
              ('expired', 'canceled', 'deleted', 'partially_canceled'))
     ORDER BY updated_at ASC
     LIMIT ?`,
  )
    .bind(screeningRefreshLimit)
    .all<CheckrScreeningRow>();
  const failures: unknown[] = [];
  let refreshed = 0;
  for (
    let index = 0;
    index < results.length;
    index += screeningRefreshConcurrency
  ) {
    const outcomes = await Promise.allSettled(
      results
        .slice(index, index + screeningRefreshConcurrency)
        .map((screening) => refreshCheckrScreening(env, screening)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") failures.push(outcome.reason);
      else if (outcome.value) refreshed += 1;
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Could not refresh ${failures.length} Checkr screening(s).`,
    );
  }
  return { refreshed, skipped: false };
}

async function refreshEventScreenings(
  env: Bindings,
  subject: CheckrEventSubject,
) {
  let screenings = await screeningsForEvent(
    env.DB,
    subject.id,
    subject.candidateId,
  );
  // Without include_object a report event carries only its ID, and a new
  // report is not linked to its screening until the first refresh.
  if (
    screenings.length === 0 &&
    subject.kind === "report" &&
    !subject.candidateId
  ) {
    const report = await getCheckrReport(env, subject.id);
    screenings = await screeningsForEvent(
      env.DB,
      subject.id,
      report.candidate_id ?? null,
    );
  }
  for (const screening of screenings) {
    await refreshCheckrScreening(env, screening);
  }
}

function checkrEventSubject(
  event: unknown,
): CheckrEventSubject | "ignored" | null {
  if (!isRecord<"data" | "type">(event) || typeof event.type !== "string") {
    return null;
  }
  const data = event.data;
  const object = isRecord<"object">(data) ? data.object : undefined;
  if (
    !isRecord<"candidate_id" | "id">(object) ||
    typeof object.id !== "string" ||
    !object.id
  ) {
    return null;
  }
  const kind = event.type.startsWith("invitation.")
    ? "invitation"
    : event.type.startsWith("report.")
      ? "report"
      : null;
  if (!kind) return "ignored";
  return {
    candidateId:
      typeof object.candidate_id === "string" && object.candidate_id
        ? object.candidate_id
        : null,
    id: object.id,
    kind,
  };
}

async function screeningsForEvent(
  database: D1Database,
  objectId: string,
  candidateId: string | null,
) {
  const { results } = await database
    .prepare(
      `SELECT id, organization_id, status, checkr_invitation_id,
              checkr_report_id, checkr_invitation_status,
              checkr_refresh_revision
       FROM employee_requirements
       WHERE checkr_invitation_id IS NOT NULL
         AND (checkr_invitation_id = ? OR checkr_report_id = ?
              OR checkr_candidate_id = ?)`,
    )
    .bind(objectId, objectId, candidateId)
    .all<CheckrScreeningRow>();
  return results;
}

function isRecord<Key extends string>(
  value: unknown,
): value is Partial<Record<Key, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
