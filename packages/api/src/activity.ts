import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import type { Bindings } from "./types";

interface ActivityRow {
  action: string;
  actor_email: string;
  actor_name: string;
  actor_user_id: string;
  details: string;
  historical: number;
  id: number;
  occurred_at: string;
  root_id: string;
  root_label: string;
  root_type: string;
  subject_id: string;
  subject_type: string;
}

interface ActivityRoot {
  id: string;
  includeGlobal?: boolean;
  type: string;
}

const pageSize = 50;

export const activity = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

activity.get("/", async (context) => {
  const page = await findActivity(
    context.env.DB,
    context.get("organizationId"),
    context.req.query("cursor"),
  );
  return page
    ? context.json(page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

/** Roots must be authorized by the caller before requesting global activity. */
export async function findActivity(
  database: D1Database,
  organizationId: string,
  cursor?: string,
  root?: ActivityRoot,
) {
  if (cursor !== undefined && !/^[1-9]\d{0,15}$/.test(cursor)) return null;
  const before = cursor === undefined ? null : Number(cursor);
  if (before !== null && !Number.isSafeInteger(before)) return null;
  const filters = [
    root?.includeGlobal ? "organization_id IS NULL" : "organization_id = ?",
  ];
  const bindings: (string | number)[] = root?.includeGlobal
    ? []
    : [organizationId];
  if (root) {
    filters.push("root_type = ? AND root_id = ?");
    bindings.push(root.type, root.id);
  }
  if (before !== null) {
    filters.push("id < ?");
    bindings.push(before);
  }
  const rows = await database
    .prepare(
      `SELECT * FROM activity_events
       WHERE ${filters.join(" AND ")}
       ORDER BY id DESC LIMIT ?`,
    )
    .bind(...bindings, pageSize + 1)
    .all<ActivityRow>();
  const page = rows.results.slice(0, pageSize);
  return {
    events: page.map(toActivity),
    nextCursor: rows.results.length > pageSize ? String(page.at(-1)?.id) : null,
  };
}

export async function findAuditAnswerActivity(
  database: D1Database,
  organizationId: string,
  auditId: string,
) {
  const rows = await database
    .prepare(
      `SELECT * FROM (
         SELECT activity_events.*,
                ROW_NUMBER() OVER (PARTITION BY subject_id ORDER BY id DESC) AS latest
         FROM activity_events
         WHERE organization_id = ? AND root_type = 'audit_run' AND root_id = ?
           AND action = 'audit.answer_changed'
       ) WHERE latest = 1`,
    )
    .bind(organizationId, auditId)
    .all<ActivityRow>();
  return Object.fromEntries(
    rows.results.map((row) => [
      row.subject_id,
      { actor: activityActor(row), occurredAt: row.occurred_at },
    ]),
  );
}

/** Include this statement in the same batch as the corresponding mutation. */
export function activityStatement(
  database: D1Database,
  input: {
    action: string;
    actorId: string;
    details: Record<string, unknown>;
    occurredAt: string;
    organizationId: string | null;
    root: { id: string; label: string; type: string };
    subject: { id: string; type: string };
  },
  condition: { bindings: (string | number | null)[]; sql: string },
) {
  return database
    .prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type, subject_id,
         action, actor_user_id, actor_name, actor_email, occurred_at, details
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, actor.id, actor.name, actor.email, ?, ?
       FROM user AS actor WHERE actor.id = ? AND (${condition.sql})`,
    )
    .bind(
      input.organizationId,
      input.root.type,
      input.root.id,
      input.root.label,
      input.subject.type,
      input.subject.id,
      input.action,
      input.occurredAt,
      JSON.stringify(input.details),
      input.actorId,
      ...condition.bindings,
    );
}

function activityActor(row: ActivityRow) {
  return {
    email: row.actor_email,
    id: row.actor_user_id,
    name: row.actor_name,
  };
}

function toActivity(row: ActivityRow) {
  return {
    action: row.action,
    actor: activityActor(row),
    details: JSON.parse(row.details) as Record<string, unknown>,
    historical: Boolean(row.historical),
    id: row.id,
    occurredAt: row.occurred_at,
    root: { id: row.root_id, label: row.root_label, type: row.root_type },
    subject: { id: row.subject_id, type: row.subject_type },
  };
}
