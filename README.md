# Tearleads

A small Bun monorepo for a Cloudflare-native product. Every workspace lives
under `packages/`:

- `packages/agent-tool` — repository automation shared by the agent workflows.
- `packages/api` — Hono API on Cloudflare Workers, with D1 and R2 bindings.
- `packages/client` — React and Vite application.
- `packages/ui` — the shared design system (tokens, component styles, React
  primitives, icons, and pricing copy) used by the client and the website.
- `packages/website` — static Astro marketing site.

Infrastructure lives outside the workspaces in `terraform` (D1, R2, and
`tearleads.de` Worker-domain infrastructure).

The tooling follows the useful core of Tearleads (Bun, Turborepo, TypeScript,
and Biome) without carrying over its mature product architecture.

## Start locally

Install [Bun](https://bun.sh/) and authenticate Wrangler with a Cloudflare
account when you are ready to provision remote resources.

```sh
bun install
bun run hooks:install
bun run --cwd packages/api db:migrate:local
bun run dev
```

Local services use these addresses:

- API: <http://localhost:8787>
- Client: <http://localhost:5173>
- Website: <http://localhost:4321>

Wrangler persists the local D1 database and R2 bucket under
`packages/api/.wrangler/`. The client defaults to the local API. Override it by
copying `packages/client/.env.example` to `packages/client/.env`.

## Authentication

The API uses Better Auth with D1-backed email/password accounts and cookie
sessions. New accounts receive the `user` role. The `admin` role can access
admin-plugin operations and the example `GET /api/admin` route. Passwords must
be 12–128 characters, reset links expire after one hour, and a successful reset
revokes the user's existing sessions.

The main endpoints under `https://api.tearleads.de/api/auth` are:

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
Email Sending to be enabled for `auth.tearleads.de`, with
`security@auth.tearleads.de` permitted as a sender. Sending DNS records and
DMARC policy are isolated under `auth.tearleads.de`; Google Workspace remains
responsible for mail at the apex. The deployment script uploads the auth secret
to the Worker but never places it in Wrangler configuration or Terraform state.

## Library folders and inbox links

Library documents can be organized into flat, organization-scoped folders,
each opened at `/library/<folder-id>`. A document lives in at most one folder;
deleting a folder returns its documents to the library root.

Inbox messages can be linked to library folders, equipment, and imported
finance transactions. Links live in one polymorphic table,
`inbound_email_links`, whose `target_type` is `library_folder`, `equipment`,
or `finance_transaction`. A polymorphic reference cannot carry a foreign key,
so database triggers remove links when their target is deleted, and purging
an email cascades to its links. An email in Trash keeps its links but is
hidden from folders and transactions until it is restored, and links to
transactions that Plaid has since removed are hidden. Creating, removing, or
seeing transaction links requires the Finance capability. A folder lists its
linked emails, and a transaction shows its linked emails in the Finance
transaction list.

PDF and image attachments preview in the inbox. PDFs are rendered in the
browser with [PDF.js](https://mozilla.github.io/pdf.js/), which loads on the
first preview; the client build copies its image decoders, colour profiles,
character maps, and standard fonts to `/pdfjs/`. Only raster image formats are
previewed, so SVG attachments download instead.

## Equipment

The organization-scoped Equipment page at `/equipment` tracks computers, cell
phones, and monitors with their make, model, serial number, and purchase date.
Each item can be assigned to one organization member at a time, and removing a
member from the organization returns their equipment to unassigned. Every
member can view equipment; organization owners and admins add, edit, assign,
and delete it. Receipts and other inbox emails link to equipment the same way
they link to folders, and any member can link or unlink them. The API owns the
list of equipment types, so adding one needs no migration; an item keeps its
type if that type is later retired.

## Contracts and e-signature

The organization-scoped Contracts page at `/contracts` sends PDFs for
signature. Any member uploads a PDF (up to 10 MB), adds signers, and places
signature, initials, date signed, full name, and text fields on its pages.
Drafts save automatically as they are edited, and sending checks that every
signer has a name, a valid email, and a signature field. Signers sign in any
order or one after another; a sequential signer is emailed only once everyone
before them has signed. A contract can carry a due date, after which it is
flagged overdue but stays signable, and a reminder interval. The hourly cron
re-emails signers who have not signed once the interval has passed since their
last email, and **Send reminder** emails them immediately, at most once an
hour. A sent contract can be voided, which invalidates its signing links;
drafts, completed, declined, and voided contracts can be deleted.

Signers need no account. Each receives a link to `/sign/<token>` from
`security@auth.tearleads.de`, with the sender's address as reply-to. The token
is an HMAC-SHA256, keyed by `BETTER_AUTH_SECRET`, of the recipient ID and a
random nonce; only the nonce and a hash of the token are stored, so reminders
can resend the same link. A link must still derive from the current secret, so
rotating `BETTER_AUTH_SECRET` invalidates every outstanding signing link; the
next reminder carries a fresh one. A signer adopts a typed or drawn signature,
agrees to use electronic records, and finishes, or declines with a reason,
which ends the contract for everyone.

When the last signer finishes, the API stamps each signature and value into
the PDF with [pdf-lib](https://pdf-lib.js.org/), honouring page rotation, and
appends a certificate of completion listing the original document's SHA-256,
each signer's time, IP address, and browser, and the audit trail. If stamping
or routing fails after a signature is recorded, the hourly cron finishes the
contract. The signed copy is emailed to every signer and the sender (attached
when it is 8 MB or smaller) and can be downloaded from the contract or the
signing link. Original and signed PDFs live in R2; deleting a contract or
organization queues them in `deleted_object_cleanup` for the scheduled purge.

## Audits and checklists

Authenticated users can build organization-scoped checklist templates at
`/audits`, start audits from them, record pass/fail/N/A or text responses, and
raise issues with priorities and optional organization-member assignees. Audit
issues can include a description, be reassigned, and have up to ten JPEG, PNG,
GIF, or WebP images attached. Image metadata is organization-scoped in D1 and
the private image bytes are stored under organization and issue prefixes in R2.
The Cloudflare Images binding validates image structure, type, and dimensions
and normalizes uploads to a single non-animated frame before anything is written
to storage.
Audit runs snapshot their template so later template edits do not rewrite
history.
Customizing a global template creates a new organization-scoped form instead
of changing the shared template or its version history. Platform administrators
use a separate management action when they intentionally publish a new global
version.

The global NFPA 70E readiness checklist is a shared starting point based on
broad electrical-safety themes. It is not an official checklist,
certification, or substitute for the current standard, an employer's required
risk assessment, or qualified professional judgment. Consult the
[NFPA 70E publication](https://link.nfpa.org/all-publications/70E/2024) and
[OSHA electrical safety requirements](https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.333)
when adapting it to a workplace.

The global U.S. residential construction baseline adds a jurisdiction-portable
starting point for detached one- and two-family dwellings and townhouses. Its
253 controls retain source, applicability, trade, phase, hazard, evidence, and
risk metadata before being compiled into the current checklist format. It is a
baseline rather than a code-compliance certification; see the
[residential audit library](docs/residential-audit-library.md) for its source,
licensing, validation, and jurisdiction-overlay rules.

## Finance and Plaid

The organization-scoped Finance page at `/finance` uses
[Plaid Link](https://plaid.com/docs/link/) to connect financial institutions
and [Transactions Sync](https://plaid.com/docs/api/products/transactions/) to
import up to 24 months of account and transaction history. Syncing is manual in
this first release; Plaid webhooks can be added later for automatic updates.
Users can add organization-scoped notes, labels, and a reviewed flag to
imported transactions.

Each organization keeps its own list of expense categories at
`/finance/categories` (with a one-click common set), and each transaction can
have at most one category, chosen inline in the transaction list. Deleting a
category leaves its transactions uncategorized. `/finance/reports` totals
expenses by category over a period: posted outflows count as spending, refunds
assigned to a category reduce it, and unassigned transfers and loan or card
payments are reported separately so money moved between the organization's own
accounts is not double-counted. Totals are grouped by currency. Earlier
free-text category overrides were converted into categories by migration
`0034`.

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
`https://app.tearleads.de/finance` to the Plaid Dashboard's allowed redirect
URIs for OAuth institutions. Before switching `PLAID_ENV` to `production` in
the API Wrangler configuration, replace the Sandbox secret with the Production
secret and complete Plaid's application and company profile requirements.

## Employee forms and screening

Organization managers assign forms, background checks, and credit checks while
inviting a member or later from Organization → People. Each requirement has a
due date. Members upload PDF, JPEG, or PNG forms (up to 10 MB) to private R2
storage; managers review and complete them. Only the member and organization
managers can download a submitted form. Checkr results are visible only to
managers. Deleted or replaced form files are queued for R2 cleanup.

Background and credit screening use Checkr's hosted invitation flow. A manager
starts a screening with the person's US work state and optional city. Checkr
emails the person to collect the information and authorization it requires.
Managers use **Refresh check** to retrieve the current invitation and report
status. A completed report is marked complete in the app; a `consider` result
still needs the manager's review in Checkr.
If a start request loses its response, retry it while Checkr's idempotency key
is valid. For an older unresolved request, look up the invitation in Checkr and
enter its ID in **Link invitation**. The app verifies the candidate, package,
and creation time before linking it. Do not start a new check until the old
request is reconciled.

Set these optional values in `.secrets/root.env` for production deployment or
`.secrets/staging.env` for staging and local development:

```sh
CHECKR_API_KEY=your-checkr-secret-key
CHECKR_BACKGROUND_PACKAGE=your-background-package-slug
CHECKR_CREDIT_PACKAGE=your-employment-credit-package-slug
```

The local and staging Workers use Checkr staging; the production Worker uses
Checkr production. Checkr must credential the account and provision a staging
account. Obtain the package slugs from the matching Checkr account, and ask
Checkr to enable an employment credit screening package if needed. The
deployment scripts upload the three values as Worker secrets when present.
Without a configured package and key, managers can still track a check
manually.

## Billing and plans

Every organization starts on the cardless Free plan with one usable member
seat, up to five organization form templates, and 30 days of audit-run history.
An hourly Worker task removes older Free-plan audit runs and their associated
issue images. Tearleads Pro costs $10 per active organization member each month
and includes unlimited form templates and audit history. Membership hooks update
the licensed Stripe subscription quantity, and an hourly reconciliation repairs
any quantity drift.

Owners and organization admins can upgrade or manage billing at
`/organization/billing`. Checkout and subscription management use Stripe-hosted
pages. Add the following values to the ignored `.secrets/root.env` before local
billing work or a production API deployment:

```sh
export STRIPE_SECRET_KEY=your-live-or-test-secret-key
export STRIPE_WEBHOOK_SECRET=your-endpoint-signing-secret
export STRIPE_PRO_LEGACY_PRICE_IDS=comma-separated-previous-pro-price-ids
export STRIPE_PRO_PRICE_ID=your-matching-live-or-test-price-id
export STRIPE_PORTAL_CONFIGURATION_ID=your-matching-portal-configuration-id
```

The current price ID is required for local billing; legacy price IDs and the
Portal configuration are optional. Add a previous Pro price ID to the legacy
list before rotating the current price so existing subscriptions keep their
entitlements. Local development overrides the production IDs in Wrangler with
these values, so test-mode keys must be paired with test-mode IDs. The public
Stripe webhook URL is
`https://api.tearleads.de/api/billing/webhook`. The non-secret Pro price and
optional Billing Portal configuration IDs belong in `packages/api/wrangler.jsonc`;
the API deployment script uploads the two secret values as encrypted Worker
secrets and requires a live-mode API key for production.

## Provision Cloudflare resources

Create the ignored `.secrets/root.env` with the Cloudflare credentials, then
review the Terraform plan. Both tokens must be scoped to the `tearleads.de`
zone; `scripts/cloudflareEnv.sh` lists every variable the scripts read:

```sh
export TF_VAR_cloudflare_api_token=your-account-token
export TF_VAR_cloudflare_account_id=your-account-id
export CLOUDFLARE_EMAIL_API_TOKEN=your-zone-token
bun run terraform:plan
```

The D1 and R2 resources have been provisioned and the D1 ID is recorded in the
API Wrangler configuration. To recreate or change infrastructure, review and
apply Terraform separately:

```sh
bun run terraform:plan
bun run terraform:apply
```

Inbound mail to `upload+<organization-id>@inbox.tearleads.de` is handled by
the API Worker. Email Routing is enabled once in the Cloudflare dashboard;
Terraform then creates the `inbox.tearleads.de` MX records and routes the
address to the Worker. The Worker stores the full `.eml` and each attachment in
the private R2 bucket, with organization-scoped delivery and attachment
metadata in D1.
Organization members can inspect their active organization's mailbox in the
client at `/inbox`. The ignored `.secrets/root.env` also needs
`CLOUDFLARE_EMAIL_API_TOKEN`; it configures subaddressing and verifies the
subdomain's Email Routing setup. The Terraform token needs Email Routing Rules
Write.

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

## Deploy staging

Staging uses separate Workers, a D1 database, an R2 bucket, and Terraform state.
Its public URLs are `staging.tearleads.de`, `app-staging.tearleads.de`, and
`api-staging.tearleads.de`. Inbound uploads use
`upload+<organization-id>@inbox-staging.tearleads.de`. The flat hostnames work
with Cloudflare Universal SSL on the `tearleads.de` zone.

Create the ignored `.secrets/staging.env` with these values. Use a new auth
secret, sandbox Plaid credentials, and Stripe test-mode credentials and price:

```sh
TF_VAR_cloudflare_api_token=...
TF_VAR_cloudflare_account_id=...
CLOUDFLARE_EMAIL_API_TOKEN=...
BETTER_AUTH_SECRET=...
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_TOKEN_ENCRYPTION_KEY=...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STAGING_STRIPE_PRO_PRICE_ID=price_...
# Optional: STAGING_STRIPE_PORTAL_CONFIGURATION_ID=bpc_...
```

Provision the isolated database and bucket before the first Worker deployment.
The first apply leaves custom domains and the inbound mail rule disabled until
their target Workers exist:

```sh
bash terraform/scripts/run.sh staging apply \
  -var=enable_custom_domains=false -var=enable_email_routing=false
DRY_RUN=1 bun run deploy:staging  # check build and Worker packaging
bun run deploy:staging
```

The staging deploy runs checks and tests, applies staging D1 migrations, updates
staging Worker secrets, deploys the three Workers, attaches the staging domains
and inbound mail route through Terraform, and checks the public URLs. Terraform
asks for confirmation before applying the domains. The generated
`wrangler.staging.jsonc` files are ignored; their D1 ID comes from staging
Terraform output. The staging API does not run production's scheduled jobs.
Configure the Stripe test-mode webhook at
`https://api-staging.tearleads.de/api/billing/webhook` and put that endpoint's
signing secret in `STRIPE_WEBHOOK_SECRET`.

For later infrastructure changes, use `bun run terraform:staging:plan` and
`bun run terraform:staging:apply`. Cloudflare Email Routing subaddressing must
be enabled once for the zone, as described in the inbound email setup above.

## Back up shared local data

Run `bun run backup:shared-data` to archive `.secrets` and, when present,
`.test_files` under `~/stealth-backups`. Pass an output directory as the first
argument. Password-protected backups are `.zip.gpg` files encrypted with GPG
AES-256 authenticated encryption; GPG prompts in an interactive terminal.
For an unattended backup, use `--password <password>` or explicitly choose an
unencrypted `.zip` with `--no-password`. Without a terminal, one of those
options is required. The password option exposes the passphrase in the backup
command's process list. To restore an encrypted backup, run
`gpg --decrypt backup.zip.gpg > backup.zip` and extract the resulting ZIP.

Organization owners can soft-delete an organization from its general settings.
The organization and its workspace data become inaccessible immediately and
retain a `deletedAt` timestamp and the initiating user's ID in D1. Root admins
can initiate the same lifecycle from the admin organization list. Preview or
permanently purge organizations that have been deleted for at least 30 days
with:

```sh
bun run organizations:purge --dry-run
bun run organizations:purge
```

The command targets Cloudflare's remote D1 database and R2 bucket by default.
Pass `--local` to exercise it against local Wrangler storage. R2 objects are
removed before the corresponding D1 organization is deleted, including uploads,
raw inbound messages, and email attachments. D1 foreign-key cascades then remove
the organization's remaining rows.

Inbox messages can be moved to Trash and restored by organization members.
Deleted messages retain their deletion time and initiating user in D1, while
their raw message and attachments remain in R2. Preview or permanently purge
messages that have been in Trash for at least 30 days with:

```sh
bun run emails:purge --dry-run
bun run emails:purge
```

The command targets Cloudflare's remote D1 database and R2 bucket by default.
Pass `--local` to use local Wrangler storage. It removes the raw message and
attachment objects before deleting the D1 email; the attachment rows are then
removed through their foreign-key cascade.

Move legacy R2 keys beneath their owning organization prefix after deploying
the organization-scoped schema:

```sh
bun run organizations:objects:reorganize --dry-run
bun run organizations:objects:reorganize
```

The move downloads each legacy object, uploads it beneath
`organizations/<organization-id>/`, verifies that the bytes match, updates its
D1 key, and only then deletes the legacy object.

Production URLs are `api.tearleads.de`, `app.tearleads.de`, and
`tearleads.de`. See [`terraform/README.md`](terraform/README.md) for state and
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

## Agent pull request flow

The `.codex/skills` and `.claude/skills` directories contain the shared review,
open, squash-merge, reset, and end-to-end ship workflows. Their implementation
is in `packages/agent-tool`. Invoke the skills rather than running the feature
checkout's package directly: each skill materializes the tool from the fetched,
trusted base commit before exposing reviewer or GitHub credentials to it.

The ship flow commits locally, requests a cross-agent review before the first
push, opens one pull request, guards the squash merge with the reviewed head and
base SHAs, and restores a clean, current `main` branch afterward.

The lint suite is adapted from Tearleads and runs Biome, Markdownlint,
ls-lint, Knip, and strict TypeScript checks. Installed Git hooks lint staged
files and conventional commit messages before they enter the repository.
