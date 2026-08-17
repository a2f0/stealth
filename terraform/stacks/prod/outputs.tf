output "zone_id" {
  description = "Cloudflare zone ID for tearleads.com."
  value       = data.cloudflare_zone.main.id
}

output "d1_database_id" {
  description = "D1 database ID to place in apps/api/wrangler.jsonc."
  value       = cloudflare_d1_database.main.id
}

output "d1_database_name" {
  description = "D1 database name bound to the API Worker."
  value       = cloudflare_d1_database.main.name
}

output "r2_bucket_name" {
  description = "R2 bucket name bound to the API Worker."
  value       = cloudflare_r2_bucket.objects.name
}

output "worker_domains" {
  description = "Desired custom-domain mapping for the three Workers."
  value       = local.worker_domains
}
