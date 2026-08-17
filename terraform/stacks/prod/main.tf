data "cloudflare_zone" "main" {
  filter = {
    account = {
      id = var.cloudflare_account_id
    }
    name = var.domain
  }
}

resource "cloudflare_d1_database" "main" {
  account_id = var.cloudflare_account_id
  name       = var.d1_database_name
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_r2_bucket" "objects" {
  account_id    = var.cloudflare_account_id
  name          = var.r2_bucket_name
  storage_class = "Standard"
}

locals {
  worker_domains = {
    api = {
      hostname = var.api_hostname
      service  = var.api_worker_name
    }
    client = {
      hostname = var.client_hostname
      service  = var.client_worker_name
    }
    website = {
      hostname = var.website_hostname
      service  = var.website_worker_name
    }
  }
}

resource "cloudflare_workers_custom_domain" "main" {
  for_each = var.enable_custom_domains ? local.worker_domains : {}

  account_id = var.cloudflare_account_id
  hostname   = each.value.hostname
  service    = each.value.service
  zone_id    = data.cloudflare_zone.main.id
}
