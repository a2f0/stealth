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
