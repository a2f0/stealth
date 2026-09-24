variable "cloudflare_api_token" {
  description = "Cloudflare API token loaded from .secrets/staging.env."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID loaded from .secrets/staging.env."
  type        = string
}

variable "domain" {
  description = "Cloudflare zone used by the product."
  type        = string
  default     = "tearleads.de"
}

variable "d1_database_name" {
  description = "Name of the D1 database bound to the API Worker."
  type        = string
  default     = "stealth-db-staging"
}

variable "r2_bucket_name" {
  description = "Name of the R2 bucket bound to the API Worker."
  type        = string
  default     = "stealth-objects-staging"
}

variable "inbound_email_subdomain" {
  description = "Subdomain that receives organization uploads through Email Routing."
  type        = string
  default     = "inbox-staging.tearleads.de"
}

variable "inbound_email_address" {
  description = "Base email address routed to the API Worker's email handler."
  type        = string
  default     = "upload@inbox-staging.tearleads.de"
}

variable "enable_custom_domains" {
  description = "Attach the canonical hostnames after the target Workers are deployed."
  type        = bool
  default     = true
}

variable "enable_email_routing" {
  description = "Add the staging inbound mail route after its Worker exists."
  type        = bool
  default     = true
}

variable "website_hostname" {
  description = "Hostname for the Astro marketing website Worker."
  type        = string
  default     = "staging.tearleads.de"
}

variable "client_hostname" {
  description = "Hostname for the React client Worker."
  type        = string
  default     = "app-staging.tearleads.de"
}

variable "api_hostname" {
  description = "Hostname for the API Worker."
  type        = string
  default     = "api-staging.tearleads.de"
}

variable "website_worker_name" {
  description = "Deployed name of the website Worker."
  type        = string
  default     = "tearleads-website-staging"
}

variable "client_worker_name" {
  description = "Deployed name of the client Worker."
  type        = string
  default     = "tearleads-client-staging"
}

variable "api_worker_name" {
  description = "Deployed name of the API Worker."
  type        = string
  default     = "tearleads-api-staging"
}
