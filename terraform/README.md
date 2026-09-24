# Cloudflare infrastructure

This stack provisions the Cloudflare resources used by the API and records the
desired Worker custom domains:

- D1 database: `stealth-db` (immutable legacy resource name)
- R2 bucket: `stealth-objects` (immutable legacy resource name)
- Email Routing MX records for `inbox.tearleads.de` (Email Routing itself is
  enabled once in the dashboard)
- Inbound email: `upload+<organization-id>@inbox.tearleads.de` → `tearleads-api`
- Website: `tearleads.de`
- Client: `app.tearleads.de`
- API: `api.tearleads.de`

The separate `stacks/staging` stack provisions `stealth-db-staging`,
`stealth-objects-staging`, staging email routing, and first-level staging
hostnames. See the staging deployment steps in the root README.

## Secrets

The scripts follow the Tearleads `.secrets` pattern and load these variables
from `.secrets/root.env` without copying them into Terraform files or state:

```sh
export TF_VAR_cloudflare_api_token="..."
export TF_VAR_cloudflare_account_id="..."
export CLOUDFLARE_EMAIL_API_TOKEN="..."
```

The `.secrets` path is ignored by Git and holds only `root.env`. The Terraform
token needs Zone Read, DNS Write, D1 Edit, R2 Edit, Workers Scripts Edit, and
Email Routing Rules Write on the `tearleads.de` zone. The separate Email API
token needs Zone Read and Zone Settings Edit on the same zone so deploys can
enable subaddressing and verify the subdomain's Email Routing DNS records.

## Plan and apply

Review the plan before making changes:

```sh
bun run terraform:plan
```

The initial scaffold uses local Terraform state, which is Git-ignored. Configure
a shared remote backend before multiple people or CI begin applying this stack.

Apply infrastructure only after the plan is understood:

```sh
bun run terraform:apply
```

The production deployment script deploys the three Workers before applying the
custom domains because each target Worker must already exist.

## Domain cutover

The domain deployment runs a read-only preflight that rejects hostnames attached
to another Worker or occupied by A, AAAA, or CNAME records. It then presents an
interactive Terraform apply:

```sh
bun run deploy:domains
```

The canonical hostnames are part of the default Terraform desired state. Set
`enable_custom_domains = false` only when intentionally removing them.

The `tearleads.com` zone stays with the other Tearleads product. Nothing in this
stack references it, and the first apply after the move destroys the old
`upload@inbox.tearleads.com` routing rule that Terraform state still tracks.
