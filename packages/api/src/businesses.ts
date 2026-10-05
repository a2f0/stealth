import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { canManageOrganization } from "./organizationMembers";
import type { Bindings } from "./types";

interface BusinessRow {
  city: string | null;
  created_at: string;
  duns: string | null;
  ein: string | null;
  id: string;
  incorporation_date: string | null;
  name: string;
  state: string | null;
  street_address: string | null;
  updated_at: string;
  zip: string | null;
}

type BusinessEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type BusinessContext = Context<BusinessEnv>;

const invalidBusinessMessage =
  "Business details are invalid. Use a valid name, EIN, DUNS number, incorporation date, street address, city, two-letter state, and ZIP code.";

export const businesses = new Hono<BusinessEnv>();

businesses.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT id, name, ein, duns, incorporation_date, street_address, city,
            state, zip, created_at, updated_at
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

businesses.get("/:id", async (context) => {
  const business = await context.env.DB.prepare(
    `SELECT id, name, ein, duns, incorporation_date, street_address, city,
            state, zip, created_at, updated_at
     FROM businesses
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .first<BusinessRow>();
  if (!business) return context.json({ error: "Business not found." }, 404);
  return context.json({
    business: businessResponse(business),
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
       (id, organization_id, name, ein, duns, incorporation_date,
        street_address, city, state, zip, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      context.get("organizationId"),
      input.name,
      input.ein ?? null,
      input.duns ?? null,
      input.incorporationDate ?? null,
      input.streetAddress ?? null,
      input.city ?? null,
      input.state ?? null,
      input.zip ?? null,
      context.get("authSession").user.id,
      timestamp,
      timestamp,
    )
    .run();
  if (result.meta.changes !== 1) {
    return duplicateIdentifier(context, id, {
      duns: input.duns ?? null,
      ein: input.ein ?? null,
    });
  }
  return context.json(
    {
      business: businessResponse({
        city: input.city ?? null,
        created_at: timestamp,
        duns: input.duns ?? null,
        ein: input.ein ?? null,
        id,
        incorporation_date: input.incorporationDate ?? null,
        name: input.name,
        state: input.state ?? null,
        street_address: input.streetAddress ?? null,
        updated_at: timestamp,
        zip: input.zip ?? null,
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
    `SELECT id, name, ein, duns, incorporation_date, street_address, city,
            state, zip, created_at, updated_at
     FROM businesses
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(id, context.get("organizationId"))
    .first<BusinessRow>();
  if (!existing) return context.json({ error: "Business not found." }, 404);

  const timestamp = new Date().toISOString();
  const city = input.city === undefined ? existing.city : input.city;
  const duns = input.duns === undefined ? existing.duns : input.duns;
  const ein = input.ein === undefined ? existing.ein : input.ein;
  const incorporationDate =
    input.incorporationDate === undefined
      ? existing.incorporation_date
      : input.incorporationDate;
  const streetAddress =
    input.streetAddress === undefined
      ? existing.street_address
      : input.streetAddress;
  const state = input.state === undefined ? existing.state : input.state;
  const zip = input.zip === undefined ? existing.zip : input.zip;
  const result = await context.env.DB.prepare(
    `UPDATE OR IGNORE businesses
     SET name = ?, ein = ?, duns = ?, incorporation_date = ?,
         street_address = ?, city = ?, state = ?, zip = ?, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(
      input.name,
      ein,
      duns,
      incorporationDate,
      streetAddress,
      city,
      state,
      zip,
      timestamp,
      id,
      context.get("organizationId"),
    )
    .run();
  if (result.meta.changes !== 1) {
    return duplicateIdentifier(context, id, { duns, ein });
  }
  const updated = await context.env.DB.prepare(
    `SELECT id, name, ein, duns, incorporation_date, street_address, city,
            state, zip, created_at, updated_at
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
    city: cityValue,
    duns,
    ein,
    incorporationDate: incorporationDateValue,
    name,
    state: stateValue,
    streetAddress: streetAddressValue,
    zip: zipValue,
  } = body as {
    city?: unknown;
    duns?: unknown;
    ein?: unknown;
    incorporationDate?: unknown;
    name?: unknown;
    state?: unknown;
    streetAddress?: unknown;
    zip?: unknown;
  };
  if (typeof name !== "string") return null;
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 120) {
    return null;
  }
  const normalizedEin = optionalString(ein, normalizeEin);
  const normalizedDuns = optionalString(duns, normalizeDuns);
  const city = optionalString(cityValue, (value) =>
    value.length <= 100 ? value : null,
  );
  const incorporationDate = optionalString(
    incorporationDateValue,
    normalizeBusinessDate,
  );
  const streetAddress = optionalString(streetAddressValue, (value) =>
    value.length <= 240 ? value : null,
  );
  const state = optionalString(stateValue, normalizeState);
  const zip = optionalString(zipValue, normalizeZip);
  if (
    !city.valid ||
    !normalizedEin.valid ||
    !normalizedDuns.valid ||
    !incorporationDate.valid ||
    !streetAddress.valid ||
    !state.valid ||
    !zip.valid
  ) {
    return null;
  }
  return {
    city: city.value,
    duns: normalizedDuns.value,
    ein: normalizedEin.value,
    incorporationDate: incorporationDate.value,
    name: normalizedName,
    state: state.value,
    streetAddress: streetAddress.value,
    zip: zip.value,
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

/** A D-U-N-S number: nine digits, bare or grouped as 12-345-6789. */
export function normalizeDuns(value: string) {
  const trimmed = value.trim();
  if (!/^(?:\d{9}|\d{2}-\d{3}-\d{4})$/.test(trimmed)) return null;
  return trimmed.replaceAll("-", "");
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

export function normalizeState(value: string) {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

export function normalizeZip(value: string) {
  const trimmed = value.trim();
  return /^\d{5}(?:-\d{4})?$/.test(trimmed) ? trimmed : null;
}

function businessResponse(row: BusinessRow) {
  return {
    city: row.city,
    createdAt: row.created_at,
    duns: row.duns,
    ein: row.ein,
    id: row.id,
    incorporationDate: row.incorporation_date,
    name: row.name,
    state: row.state,
    streetAddress: row.street_address,
    updatedAt: row.updated_at,
    zip: row.zip,
  };
}

/**
 * A write was ignored because another business in the organization already
 * holds one of its identifiers; name the DUNS number only when it alone
 * collides.
 */
async function duplicateIdentifier(
  context: BusinessContext,
  id: string,
  { duns, ein }: { duns: string | null; ein: string | null },
) {
  const holders = await context.env.DB.prepare(
    `SELECT ein, duns
     FROM businesses
     WHERE organization_id = ? AND id <> ? AND (ein = ? OR duns = ?)`,
  )
    .bind(context.get("organizationId"), id, ein, duns)
    .all<Pick<BusinessRow, "duns" | "ein">>();
  const held = (field: "duns" | "ein", value: string | null) =>
    value !== null && holders.results.some((holder) => holder[field] === value);
  const identifier =
    held("duns", duns) && !held("ein", ein) ? "DUNS number" : "EIN";
  return context.json(
    { error: `A business with that ${identifier} already exists.` },
    409,
  );
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
