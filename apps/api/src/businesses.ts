import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { canManageOrganization } from "./organizationMembers";
import type { Bindings } from "./types";

interface BusinessRow {
  created_at: string;
  ein: string;
  id: string;
  name: string;
  updated_at: string;
}

type BusinessEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type BusinessContext = Context<BusinessEnv>;

export const businesses = new Hono<BusinessEnv>();

businesses.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT id, name, ein, created_at, updated_at
     FROM businesses
     WHERE organization_id = ?
     ORDER BY created_at DESC, id DESC`,
  )
    .bind(context.get("organizationId"))
    .all<BusinessRow>();
  return context.json({
    businesses: result.results.map(businessResponse),
    canManage: canManage(context),
  });
});

businesses.post("/", async (context) => {
  if (!canManage(context)) return managerRequired(context);
  const body: unknown = await context.req.json().catch(() => null);
  const input = businessInput(body);
  if (!input) {
    return context.json(
      { error: "A business name and valid 9-digit EIN are required." },
      400,
    );
  }

  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `INSERT OR IGNORE INTO businesses
       (id, organization_id, name, ein, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      context.get("organizationId"),
      input.name,
      input.ein,
      context.get("authSession").user.id,
      timestamp,
      timestamp,
    )
    .run();
  if (result.meta.changes !== 1) {
    return context.json(
      { error: "A business with that EIN already exists." },
      409,
    );
  }
  return context.json(
    {
      business: businessResponse({
        created_at: timestamp,
        ein: input.ein,
        id,
        name: input.name,
        updated_at: timestamp,
      }),
    },
    201,
  );
});

businesses.delete("/:id", async (context) => {
  if (!canManage(context)) return managerRequired(context);
  const result = await context.env.DB.prepare(
    `DELETE FROM businesses
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .run();
  if (result.meta.changes !== 1) {
    return context.json({ error: "Business not found." }, 404);
  }
  return context.body(null, 204);
});

function businessInput(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const { ein, name } = body as { ein?: unknown; name?: unknown };
  if (typeof name !== "string" || typeof ein !== "string") return null;
  const normalizedName = name.trim();
  const normalizedEin = normalizeEin(ein);
  if (!normalizedName || normalizedName.length > 120 || !normalizedEin) {
    return null;
  }
  return { ein: normalizedEin, name: normalizedName };
}

export function normalizeEin(value: string) {
  const trimmed = value.trim();
  if (!/^\d{2}-?\d{7}$/.test(trimmed)) return null;
  return trimmed.replace("-", "");
}

function businessResponse(row: BusinessRow) {
  return {
    createdAt: row.created_at,
    ein: row.ein,
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
  };
}

function canManage(context: BusinessContext) {
  return canManageOrganization(context.get("organizationRole"));
}

function managerRequired(context: BusinessContext) {
  return context.json(
    { error: "Organization manager access is required." },
    403,
  );
}
