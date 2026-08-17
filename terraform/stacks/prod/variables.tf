variable "cloudflare_api_token" {
  description = "Cloudflare API token loaded from .secrets/root.env."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID loaded from .secrets/root.env."
  type        = string
}

variable "domain" {
  description = "Cloudflare zone used by the product."
  type        = string
  default     = "tearleads.com"
}

variable "d1_database_name" {
  description = "Name of the D1 database bound to the API Worker."
  type        = string
  default     = "stealth-db"
}

variable "r2_bucket_name" {
  description = "Name of the R2 bucket bound to the API Worker."
  type        = string
  default     = "stealth-objects"
}

variable "enable_custom_domains" {
  description = "Attach the canonical hostnames after the target Workers are deployed."
  type        = bool
  default     = true
}

variable "website_hostname" {
  description = "Hostname for the Astro marketing website Worker."
  type        = string
  default     = "tearleads.com"
}

variable "client_hostname" {
  description = "Hostname for the React client Worker."
  type        = string
  default     = "app.tearleads.com"
}

variable "api_hostname" {
  description = "Hostname for the API Worker."
  type        = string
  default     = "api.tearleads.com"
}

variable "website_worker_name" {
  description = "Deployed name of the website Worker."
  type        = string
  default     = "stealth-website"
}

variable "client_worker_name" {
  description = "Deployed name of the client Worker."
  type        = string
  default     = "stealth-client"
}

variable "api_worker_name" {
  description = "Deployed name of the API Worker."
  type        = string
  default     = "stealth-api"
}
