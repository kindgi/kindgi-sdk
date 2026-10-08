# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# ---- where ------------------------------------------------------------------

variable "subscription_id" {
  description = "The Azure subscription the resource group is in."
  type        = string
}

variable "resource_group_name" {
  description = "An existing resource group for everything this module creates. The module reads it; it never creates or changes a resource group."
  type        = string
}

variable "location" {
  description = "Azure region for every resource. null: the resource group's."
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "Prefix for every resource name. Key Vault, Container Registry and PostgreSQL names are global, so those also get a random 4-character suffix. Lowercase letters, digits and dashes, at most 12."
  type        = string
  default     = "kindgi"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,11}$", var.name_prefix)) && !strcontains(var.name_prefix, "--") && !endswith(var.name_prefix, "-")
    error_message = "name_prefix: 2-12 lowercase letters, digits and single dashes, starting with a letter."
  }
}

variable "tags" {
  description = "Tags on every resource the module creates (e.g. an owner and a purpose), plus kindgi-deployment = name_prefix. The private DNS zone and its link drop tag names with a colon (Azure ignores them there)."
  type        = map(string)
  default     = {}
}

variable "kindgi_env" {
  description = "KINDGI_ENV: the env name this runtime serves. Secrets tools declare by name resolve under it."
  type        = string
}

# ---- images -------------------------------------------------------------------

variable "server_image" {
  description = "The Kindgi runtime image, by digest, in this module's Container Registry (mirrored from Quay; see README)."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.server_image))
    error_message = "Pin the runtime image by digest (…@sha256:<64 hex>)."
  }
}

variable "pack_image" {
  description = "The pack image `kindgi build` produced, by digest, in this module's Container Registry."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.pack_image))
    error_message = "Pin the pack image by digest (…@sha256:<64 hex>)."
  }
}

# ---- the server ---------------------------------------------------------------

variable "seed_tenant_id" {
  description = "KINDGI_TENANT_ID: the tenant the server seeds and runs background work for. Keep it for the deployment's life."
  type        = string
}

variable "seed_user_id" {
  description = "KINDGI_SEED_USER_ID: the first admin user. Keep it for the deployment's life."
  type        = string
}

variable "server_cpu" {
  description = "vCPUs for the server's one replica (Container Apps Consumption: 0.25 to 4, in steps of 0.25)."
  type        = number
  default     = 1
}

variable "server_memory" {
  description = "Memory for the server's replica: twice its vCPUs, in Gi (e.g. \"2Gi\" with 1 vCPU)."
  type        = string
  default     = "2Gi"
}

variable "server_ip_allowlist" {
  description = "CIDRs allowed to reach the server's URL. Empty: anyone (the API checks its bearer tokens on every route either way)."
  type        = list(string)
  default     = []
}

variable "environment_internal" {
  description = "Put the Container Apps environment on an internal load balancer: the server's URL is reachable only from the VNet (and what's peered or connected to it). Fixed when the environment is created."
  type        = bool
  default     = false
}

variable "cors_origins" {
  description = "KINDGI_CORS_ORIGINS: exact browser origins allowed on the routes a public run token opens."
  type        = list(string)
  default     = []
}

variable "export_signing" {
  description = "How the server signs exports (approval audit bundles, run provenance, compliance evidence). \"none\": exports answer 404 signing-not-configured. \"secret\": a key you put in the vault as export-signing-key (a PEM private key, Ed25519 or EC P-256, base64), as KINDGI_EXPORT_SIGNING_KEY. \"kms\": the module makes an EC P-256 key in the vault (<name_prefix>-exports) and the server signs with it there, as KINDGI_EXPORT_SIGNING_KMS_KEY: the private key never leaves Key Vault, and exports are ecdsa-p256-sha256 (Key Vault has no Ed25519)."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "secret", "kms"], var.export_signing)
    error_message = "export_signing must be none, secret or kms."
  }
}

variable "trusted_proxies" {
  description = "KINDGI_TRUSTED_PROXIES on the server: which proxies in front of it to trust for a client's address, which rate limits and audit records use. A hop count, or comma-separated IPs/CIDR ranges. Container Apps' ingress appends the client to X-Forwarded-For, so 1; add one for each proxy you put in front of it (Front Door or Application Gateway: 2). Empty leaves it unset, and every client counts as the ingress."
  type        = string
  default     = "1"

  validation {
    condition     = var.trusted_proxies == "" || can(regex("^[1-9][0-9]*$", var.trusted_proxies)) || can(regex("^[0-9a-fA-F]*[.:][0-9a-fA-F:./]*( *, *[0-9a-fA-F]*[.:][0-9a-fA-F:./]*)*$", var.trusted_proxies))
    error_message = "trusted_proxies: a hop count (1, 2, ...) or comma-separated IPs/CIDR ranges."
  }
}

variable "openfga_api_url" {
  description = "KINDGI_OPENFGA_API_URL, when authorization runs on an OpenFGA server."
  type        = string
  default     = ""
}

# ---- the pack service -----------------------------------------------------------

variable "pack_cpu" {
  description = "vCPUs per pack service replica."
  type        = number
  default     = 0.5
}

variable "pack_memory" {
  description = "Memory per pack service replica: twice its vCPUs, in Gi."
  type        = string
  default     = "1Gi"
}

variable "pack_min_instances" {
  description = "Minimum pack service replicas."
  type        = number
  default     = 1
}

variable "pack_max_instances" {
  description = "Maximum pack service replicas."
  type        = number
  default     = 8
}

variable "pack_concurrency" {
  description = "Concurrent calls per pack replica: the scale rule's target and KINDGI_PACK_SERVICE_MAX_CONCURRENCY."
  type        = number
  default     = 32
}

variable "pack_env" {
  description = "The pack's plain env, `env` from `kindgi env plan --env <name>`."
  type        = map(string)
  default     = {}
}

variable "pack_secret_env" {
  description = "The pack's secret env, `secret_env` from `kindgi env plan --env <name>`: each a secret in this module's Key Vault (`secret`) and its version (`latest`, or a version id). The pack service gets read access to exactly these."
  type = map(object({
    secret  = string
    version = string
    project = optional(string)
  }))
  default = {}

  validation {
    condition     = alltrue([for ref in values(var.pack_secret_env) : ref.project == null])
    error_message = "pack_secret_env: `project` names a GCP project. On Azure each secret is a name in this module's Key Vault."
  }

  validation {
    condition     = alltrue([for ref in values(var.pack_secret_env) : can(regex("^[0-9A-Za-z-]{1,127}$", ref.secret)) && can(regex("^(latest|[0-9a-f]{32})$", ref.version))])
    error_message = "pack_secret_env: a Key Vault secret name (letters, digits, dashes) and `latest` or a 32-hex version id."
  }
}

variable "pack_call_timeout_ms" {
  description = "KINDGI_PACK_CALL_TIMEOUT_MS on the server: how long it waits for one tool call (the runtime's default is 120000). Container Apps cuts any request at 240 s, so it must stay below that. null leaves the default."
  type        = number
  default     = null

  validation {
    condition     = var.pack_call_timeout_ms == null || (var.pack_call_timeout_ms > 0 && var.pack_call_timeout_ms < 240000)
    error_message = "pack_call_timeout_ms must be under 240000: Container Apps cuts every request at 240 s. A tool that needs longer can't run behind it."
  }
}

# ---- the network ----------------------------------------------------------------

variable "vnet_cidr" {
  description = "New-VNet shape: the VNet's address space."
  type        = string
  default     = "10.20.0.0/16"
}

variable "environment_subnet_cidr" {
  description = "New-VNet shape: the Container Apps environment's subnet (/27 or larger)."
  type        = string
  default     = "10.20.0.0/24"
}

variable "database_subnet_cidr" {
  description = "New-VNet shape: PostgreSQL's delegated subnet."
  type        = string
  default     = "10.20.1.0/28"
}

variable "environment_subnet_id" {
  description = "Existing-VNet shape: an empty subnet delegated to Microsoft.App/environments, in the VNet whose private resources the pack's tools reach. Set it with database_subnet_id and database_private_dns_zone_id; the module then creates no network."
  type        = string
  default     = ""

  validation {
    condition     = (var.environment_subnet_id == "") == (var.database_subnet_id == "") && (var.environment_subnet_id == "") == (var.database_private_dns_zone_id == "")
    error_message = "The existing-VNet shape needs all three, or none: environment_subnet_id, database_subnet_id and database_private_dns_zone_id."
  }
}

variable "database_subnet_id" {
  description = "Existing-VNet shape: an empty subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers, in the same VNet."
  type        = string
  default     = ""
}

variable "database_private_dns_zone_id" {
  description = "Existing-VNet shape: a private DNS zone ending in .postgres.database.azure.com, linked to the VNet."
  type        = string
  default     = ""
}

# ---- the database ---------------------------------------------------------------

variable "database_sku" {
  description = "PostgreSQL Flexible Server SKU (tier_size), e.g. B_Standard_B1ms (burstable), GP_Standard_D2s_v3."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "database_version" {
  description = "PostgreSQL major version: 16 or later (pgvector is allowed through azure.extensions)."
  type        = string
  default     = "16"

  validation {
    condition     = can(tonumber(var.database_version)) && tonumber(var.database_version) >= 16
    error_message = "database_version must be 16 or later."
  }
}

variable "database_storage_mb" {
  description = "PostgreSQL storage in MB."
  type        = number
  default     = 32768
}

variable "database_backup_retention_days" {
  description = "Days of automatic backups (point-in-time restore), 7 to 35."
  type        = number
  default     = 7
}

variable "database_name" {
  description = "Kindgi's database on the server."
  type        = string
  default     = "kindgi"
}

# ---- Key Vault --------------------------------------------------------------------

variable "key_vault_purge_protection" {
  description = "Purge protection on the vault: a deleted vault, key or secret stays recoverable for the retention period, and nobody can purge it sooner. On for anything holding real secrets."
  type        = bool
  default     = true
}

variable "key_vault_soft_delete_retention_days" {
  description = "Days a deleted vault, key or secret stays recoverable (7 to 90)."
  type        = number
  default     = 90
}

variable "key_vault_purge_on_destroy" {
  description = "Purge the vault when this module is destroyed, so its name is free at once. Only with purge protection off (a sandbox)."
  type        = bool
  default     = false
}

variable "key_rotation_days" {
  description = "Rotate the key that wraps the secrets every N days (a new key version; old versions keep unwrapping). 0: no rotation policy."
  type        = number
  default     = 90
}

variable "key_vault_admins" {
  description = "Object ids of the people or groups who add the secret values and manage the key (Key Vault Secrets Officer and Crypto Officer). Whoever runs Terraform is always one."
  type        = list(string)
  default     = []
}

variable "secrets_aad_key_version" {
  description = "The version of the `secrets-aad-key` secret the server reads (`az keyvault secret set` prints it). Pinned, never `latest`: a new version would make every stored secret unreadable. Needed for the services apply."
  type        = string
  default     = ""

  validation {
    condition     = var.secrets_aad_key_version == "" || can(regex("^[0-9a-f]{32}$", var.secrets_aad_key_version))
    error_message = "secrets_aad_key_version: a 32-hex Key Vault secret version id."
  }
}

variable "erasure_ledger_key_version" {
  description = "The version of the `erasure-ledger-key` secret the server reads (`az keyvault secret set` prints it): KINDGI_ERASURE_LEDGER_KEY, the erasure ledger's keyed hash. Pinned, never `latest`: erasures replay after a backup restore only with the same key. Needed for the services apply."
  type        = string
  default     = ""

  validation {
    condition     = var.erasure_ledger_key_version == "" || can(regex("^[0-9a-f]{32}$", var.erasure_ledger_key_version))
    error_message = "erasure_ledger_key_version: a 32-hex Key Vault secret version id."
  }
}
