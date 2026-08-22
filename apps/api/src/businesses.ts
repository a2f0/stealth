import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { canManageOrganization } from "./organizationMembers";
import type { Bindings } from "./types";

interface BusinessRow {
  created_at: string;
  ein: string | null;
  id: string;
  incorporation_date: string | null;
  name: string;
  street_address: string | null;
  updated_at: string;
}

type BusinessEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type BusinessContext = Context<BusinessEnv>;

const invalidBusinessMessage =
  "Business details are invalid. Name is required, EIN must be 9 digits, incorporation date must be a valid date, and street address must be 240 characters or less.";

export const businesses = new Hono<BusinessEnv>();

businesses.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT id, name, ein, incorporation_date, street_address,
            created_at, updated_at
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
    return context.json({ error: invalidBusinessMessage }, 400);
  }

  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `INSERT OR IGNORE INTO businesses
       (id, organization_id, name, ein, incorporation_date, street_address,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      context.get("organizationId"),
      input.name,
      input.ein ?? null,
      input.incorporationDate ?? null,
      input.streetAddress ?? null,
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
        ein: input.ein ?? null,
        id,
        incorporation_date: input.incorporationDate ?? null,
        name: input.name,
        street_address: input.streetAddress ?? null,
        updated_at: timestamp,
      }),
    },
    201,
  );
});

businesses.patch("/:id", async (context) => {
  if (!canManage(context)) return managerRequired(context);
  const body: unknown = await context.req.json().catch(() => null);
  const input = businessInput(body);
  if (!input) {
    return context.json({ error: invalidBusinessMessage }, 400);
  }

  const id = context.req.param("id");
  const existing = await context.env.DB.prepare(
    `SELECT id, name, ein, incorporation_date, street_address,
            created_at, updated_at
     FROM businesses
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(id, context.get("organizationId"))
    .first<BusinessRow>();
  if (!existing) return context.json({ error: "Business not found." }, 404);

  const timestamp = new Date().toISOString();
  const ein = input.ein === undefined ? existing.ein : input.ein;
  const incorporationDate =
    input.incorporationDate === undefined
      ? existing.incorporation_date
      : input.incorporationDate;
  const streetAddress =
    input.streetAddress === undefined
      ? existing.street_address
      : input.streetAddress;
  const result = await context.env.DB.prepare(
    `UPDATE OR IGNORE businesses
     SET name = ?, ein = ?, incorporation_date = ?, street_address = ?,
         updated_at = ?
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(
      input.name,
      ein,
      incorporationDate,
      streetAddress,
      timestamp,
      id,
      context.get("organizationId"),
    )
    .run();
  if (result.meta.changes !== 1) {
    return context.json(
      { error: "A business with that EIN already exists." },
      409,
    );
  }
  const updated = await context.env.DB.prepare(
    `SELECT id, name, ein, incorporation_date, street_address,
            created_at, updated_at
     FROM businesses
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(id, context.get("organizationId"))
    .first<BusinessRow>();
  if (!updated) return context.json({ error: "Business not found." }, 404);
  return context.json({
    business: businessResponse(updated),
  });
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
  const {
    ein,
    incorporationDate: incorporationDateValue,
    name,
    streetAddress: streetAddressValue,
  } = body as {
    ein?: unknown;
    incorporationDate?: unknown;
    name?: unknown;
    streetAddress?: unknown;
  };
  if (typeof name !== "string") return null;
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 120) {
    return null;
  }
  const normalizedEin = optionalString(ein, normalizeEin);
  const incorporationDate = optionalString(
    incorporationDateValue,
    normalizeBusinessDate,
  );
  const streetAddress = optionalString(streetAddressValue, (value) =>
    value.length <= 240 ? value : null,
  );
  if (
    !normalizedEin.valid ||
    !incorporationDate.valid ||
    !streetAddress.valid
  ) {
    return null;
  }
  return {
    ein: normalizedEin.value,
    incorporationDate: incorporationDate.value,
    name: normalizedName,
    streetAddress: streetAddress.value,
  };
}

function optionalString(
  value: unknown,
  normalize: (value: string) => string | null,
): { valid: false } | { valid: true; value: string | null | undefined } {
  if (value === undefined) return { valid: true, value: undefined };
  if (value === null) return { valid: true, value: null };
  if (typeof value !== "string") return { valid: false };
  const trimmed = value.trim();
  if (!trimmed) return { valid: true, value: null };
  const normalized = normalize(trimmed);
  return normalized ? { valid: true, value: normalized } : { valid: false };
}

export function normalizeEin(value: string) {
  const trimmed = value.trim();
  if (!/^\d{2}-?\d{7}$/.test(trimmed)) return null;
  return trimmed.replace("-", "");
}

export function normalizeBusinessDate(value: string) {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === trimmed
    ? trimmed
    : null;
}

function businessResponse(row: BusinessRow) {
  return {
    createdAt: row.created_at,
    ein: row.ein,
    id: row.id,
    incorporationDate: row.incorporation_date,
    name: row.name,
    streetAddress: row.street_address,
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
