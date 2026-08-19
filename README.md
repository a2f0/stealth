# Stealth

A small Bun monorepo for a Cloudflare-native product:

- `apps/api` — Hono API on Cloudflare Workers, with D1 and R2 bindings.
- `apps/client` — React and Vite application.
- `apps/website` — static Astro marketing site.
- `terraform` — D1, R2, and `tearleads.com` Worker-domain infrastructure.

The tooling follows the useful core of Tearleads (Bun, Turborepo, TypeScript,
and Biome) without carrying over its mature product architecture. There is no
shared package yet; add one only when two apps have real code to share.

## Start locally

Install [Bun](https://bun.sh/) and authenticate Wrangler with a Cloudflare
account when you are ready to provision remote resources.

```sh
bun install
bun run hooks:install
bun run --cwd apps/api db:migrate:local
bun run dev
```

Local services use these addresses:

- API: <http://localhost:8787>
- Client: <http://localhost:5173>
- Website: <http://localhost:4321>

Wrangler persists the local D1 database and R2 bucket under
`apps/api/.wrangler/`. The client defaults to the local API. Override it by
copying `apps/client/.env.example` to `apps/client/.env`.

## Authentication

The API uses Better Auth with D1-backed email/password accounts and cookie
sessions. New accounts receive the `user` role. The `admin` role can access
admin-plugin operations and the example `GET /api/admin` route. Passwords must
be 12–128 characters, reset links expire after one hour, and a successful reset
revokes the user's existing sessions.

The main endpoints under `https://api.tearleads.com/api/auth` are:

- `POST /sign-up/email`
- `POST /sign-in/email`
- `POST /sign-out`
- `GET /get-session`
- `POST /request-password-reset`
- `POST /reset-password`
- `GET /admin/list-users` (admin only)
- `GET /organization/list`
- `POST /organization/update`

After creating the first account, bootstrap its admin role with:

```sh
bun run auth:set-role person@example.com admin
```

Pass `--local` as the third argument to update the local D1 database instead.
Later role changes can use Better Auth's admin API. Public account registration
is enabled for now. The client includes sign-up, sign-in, sign-out, reset
request, and new-password screens. Object-storage endpoints require an
authenticated session, and each organization's upload library is isolated in
D1 with new R2 objects stored below an organization-specific prefix.
Registration sends a
one-hour verification link, but unverified users can sign in immediately. The
library displays a reminder with a resend action until the address is verified.
Admins can list registered accounts at `/admin` and view the shared inbound
mailbox at `/inbox`. Each account receives a default organization at signup;
existing accounts are backfilled by the organization migration. Users can
rename their organization at `/organization`, and admins can inspect all
organizations on the `/admin` page. The API independently enforces the admin
role for administrative data.

Organization owners and organization admins can manage groups and group
members at `/organization`. Groups use Better Auth teams underneath and can
grant application capabilities. Every organization starts with a Finance group
containing its initial owner; Finance navigation and every `/api/finance`
request require membership in a group with the Finance capability.

Authentication needs a strong `BETTER_AUTH_SECRET` in the ignored
`.secrets/root.env`. Production password reset additionally requires Cloudflare
Email Sending to be enabled for `auth.tearleads.com`, with
`security@auth.tearleads.com` permitted as a sender. Sending DNS records and
DMARC policy are isolated under `auth.tearleads.com`; Google Workspace remains
responsible for mail at the apex. The deployment script uploads the auth secret
to the Worker but never places it in Wrangler configuration or Terraform state.

## Audits and checklists

Authenticated users can build organization-scoped checklist templates at
`/audits`, start audits from them, record pass/fail/N/A or text responses, and
raise issues with priorities and optional organization-member assignees. Audit
runs snapshot their template so later template edits do not rewrite history.

The seeded NFPA 70E readiness checklist is a customizable starting point based
on broad electrical-safety themes. It is not an official checklist,
certification, or substitute for the current standard, an employer's required
risk assessment, or qualified professional judgment. Consult the
[NFPA 70E publication](https://link.nfpa.org/all-publications/70E/2024) and
[OSHA electrical safety requirements](https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.333)
when adapting it to a workplace.

## Finance and Plaid

The organization-scoped Finance page at `/finance` uses
[Plaid Link](https://plaid.com/docs/link/) to connect financial institutions
and [Transactions Sync](https://plaid.com/docs/api/products/transactions/) to
import up to 24 months of account and transaction history. Syncing is manual in
this first release; Plaid webhooks can be added later for automatic updates.
Users can add organization-scoped notes, category overrides, labels, and a
reviewed flag to imported transactions.

Disconnecting an institution calls Plaid's `/item/remove`, erases the stored
access token, and retains the imported history and annotations. A later Link
connection reconciles unambiguous matching accounts and transactions onto the
same internal records so annotations survive changed Plaid IDs. Deleting the
local history is a separate, permanent action that is only available after the
institution has been disconnected.

Plaid access tokens are encrypted with AES-GCM before being stored in D1. Add
these values to the ignored `.secrets/root.env` before local Plaid testing or a
production deployment:

```sh
export PLAID_CLIENT_ID=your-client-id
export PLAID_SECRET=your-sandbox-secret
export PLAID_TOKEN_ENCRYPTION_KEY=your-base64-32-byte-key
```

Generate the encryption key once with `openssl rand -base64 32`, store the
result, and do not replace it casually: existing connections require the same
key to decrypt their Plaid access tokens. The deployment script uploads all
three values as encrypted Worker secrets.

The Worker currently uses Plaid Sandbox. Add
`https://app.tearleads.com/finance` to the Plaid Dashboard's allowed redirect
URIs for OAuth institutions. Before switching `PLAID_ENV` to `production` in
the API Wrangler configuration, replace the Sandbox secret with the Production
secret and complete Plaid's application and company profile requirements.

## Provision Cloudflare resources

Link or create the ignored `.secrets` directory, then review the Terraform
plan. The local setup shares Tearleads' existing secret store:

```sh
ln -s ../tearleads-shared/.secrets .secrets
bun run terraform:plan
```

The D1 and R2 resources have been provisioned and the D1 ID is recorded in the
API Wrangler configuration. To recreate or change infrastructure, review and
apply Terraform separately:

```sh
bun run terraform:plan
bun run terraform:apply
```

Inbound mail to `upload@inbox.tearleads.com` is handled by the API Worker. It
stores the full `.eml` and each attachment in the private R2 bucket, with
delivery and attachment metadata in D1. Admins can inspect the mailbox in the
client at `/inbox`. The ignored `.secrets/root.env` also needs
`CLOUDFLARE_EMAIL_API_TOKEN`; it is used only to verify the subdomain's Email
Routing setup. The Terraform token needs Email Routing Rules Write.

## Deploy production

The full deployment checks the repository, applies D1 migrations, deploys the
API, app, and website Workers, checks that the production hostnames are safe,
attaches them through Terraform, and verifies the public URLs:

```sh
bun run deploy
```

Terraform shows its domain plan and asks for confirmation. For a reviewed,
non-interactive deployment, use `AUTO_APPROVE=1 bun run deploy`.

Exercise checks, production builds, and Wrangler packaging without changing
remote state:

```sh
DRY_RUN=1 bun run deploy
```

Each deployment lane is also available independently:

```sh
bun run deploy:api      # migrate D1 and deploy the API Worker
bun run deploy:app      # build with the production API URL and deploy
bun run deploy:website  # build with the production app URL and deploy
bun run deploy:domains  # preflight and attach custom domains
bun run deploy:email:verify # verify inbound MX records and Worker route
bun run deploy:verify   # check all production URLs
```

Production URLs are `api.tearleads.com`, `app.tearleads.com`, and
`tearleads.com`. See [`terraform/README.md`](terraform/README.md) for state and
domain details.

## Useful commands

```sh
bun run dev       # run all three apps
bun run check     # lint and type-check everything
bun run test      # run package tests
bun run build     # create production builds
bun run format    # format source and Markdown
bun run deploy    # deploy and verify production
bun run terraform:plan # preview Cloudflare infrastructure
```

The lint suite is adapted from Tearleads and runs Biome, Markdownlint,
ls-lint, Knip, and strict TypeScript checks. Installed Git hooks lint staged
files and conventional commit messages before they enter the repository.
