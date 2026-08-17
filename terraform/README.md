# Cloudflare infrastructure

This stack provisions the Cloudflare resources used by the API and records the
desired Worker custom domains:

- D1 database: `stealth-db`
- R2 bucket: `stealth-objects`
- Website: `tearleads.com`
- Client: `app.tearleads.com`
- API: `api.tearleads.com`

## Secrets

The scripts follow the Tearleads `.secrets` pattern and load these variables
from `.secrets/root.env` without copying them into Terraform files or state:

```sh
export TF_VAR_cloudflare_api_token="..."
export TF_VAR_cloudflare_account_id="..."
```

For local development alongside the Tearleads repositories, link the shared
secret store:

```sh
ln -s ../tearleads-shared/.secrets .secrets
```

The `.secrets` path is ignored by Git. The token needs Zone Read, D1 Edit, and
R2 Edit permissions. Workers Scripts Edit is also needed when custom domains
are enabled.

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
