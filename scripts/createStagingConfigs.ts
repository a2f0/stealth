import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for staging.`);
  return value;
};

async function config(app: string): Promise<Record<string, unknown>> {
  const source = resolve(root, "apps", app, "wrangler.jsonc");
  const parsed = ts.parseConfigFileTextToJson(
    source,
    await readFile(source, "utf8"),
  );
  if (parsed.error || !parsed.config) {
    throw new Error(`Could not parse ${source}`);
  }
  return parsed.config as Record<string, unknown>;
}

async function save(app: string, value: Record<string, unknown>) {
  const path = resolve(root, "apps", app, "wrangler.staging.jsonc");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  console.log(`Created ${path}`);
}

const api = await config("api");
api.name = "tearleads-api-staging";
api.vars = {
  ...(api.vars as Record<string, unknown>),
  BETTER_AUTH_URL: "https://api-staging.tearleads.de",
  CORS_ORIGIN: "https://app-staging.tearleads.de",
  CHECKR_ENV: "staging",
  INBOUND_EMAIL_DOMAIN: "inbox-staging.tearleads.de",
  PLAID_ENV: "sandbox",
  PLAID_REDIRECT_URI: "https://app-staging.tearleads.de/finance",
  STRIPE_PORTAL_CONFIGURATION_ID:
    process.env.STAGING_STRIPE_PORTAL_CONFIGURATION_ID ?? "",
  STRIPE_PRO_LEGACY_PRICE_IDS: "",
  STRIPE_PRO_PRICE_ID: required("STAGING_STRIPE_PRO_PRICE_ID"),
};
api.d1_databases = [
  {
    binding: "DB",
    database_name: required("STAGING_D1_DATABASE_NAME"),
    database_id: required("STAGING_D1_DATABASE_ID"),
    migrations_dir: "migrations",
  },
];
api.r2_buckets = [
  { binding: "STORAGE", bucket_name: required("STAGING_R2_BUCKET_NAME") },
];
// Staging has its own data and should not run production's scheduled jobs.
delete api.triggers;
await save("api", api);

const client = await config("client");
client.name = "tearleads-client-staging";
await save("client", client);

const website = await config("website");
website.name = "tearleads-website-staging";
await save("website", website);
