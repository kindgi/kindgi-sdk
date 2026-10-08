# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# Kindgi's database and the names of the secrets both services read.
#
# Secrets by reference: a Key Vault secret can't exist without a value, so
# Terraform creates the vault and who may read what, and outputs the
# secret names. The operator adds every value with `az keyvault secret
# set` (README), so no secret is in the Terraform state or plan.

# ---- PostgreSQL Flexible Server -------------------------------------------------
# VNet-integrated: a private address in the delegated subnet, no public
# access (C-DB-5), TLS required (`sslmode=require` in the URL). The runtime
# signs in as the server's admin login (C-DB-3: a member of azure_pg_admin
# with CREATEROLE, not a superuser: Cloud SQL's built-in user, on Azure).

# The admin password is write-only: Terraform sends a random one at
# creation and keeps it nowhere, not in the state, not in the plan. Nobody
# knows it until the operator sets the real one (README, step 3).
ephemeral "random_password" "database_admin" {
  length  = 32
  special = false
}

resource "azurerm_postgresql_flexible_server" "kindgi" {
  name                              = "${var.name_prefix}-pg-${local.suffix}"
  location                          = local.location
  resource_group_name               = data.azurerm_resource_group.kindgi.name
  version                           = var.database_version
  sku_name                          = var.database_sku
  storage_mb                        = var.database_storage_mb
  backup_retention_days             = var.database_backup_retention_days
  geo_redundant_backup_enabled      = false
  delegated_subnet_id               = local.database_subnet_id
  private_dns_zone_id               = local.database_dns_zone_id
  public_network_access_enabled     = false
  administrator_login               = local.database_admin_login
  administrator_password_wo         = ephemeral.random_password.database_admin.result
  administrator_password_wo_version = 1
  tags                              = local.tags

  authentication {
    password_auth_enabled         = true
    active_directory_auth_enabled = false
  }

  # Azure picks the zone; don't move the server on the next plan.
  lifecycle {
    ignore_changes = [zone]
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.database]
}

locals {
  database_admin_login = "kindgiadmin"
}

# C-DB-1: pgvector is allowed through the server's extension allowlist; the
# runtime then runs `CREATE EXTENSION IF NOT EXISTS vector` itself.
resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.kindgi.id
  value     = "VECTOR"
}

resource "azurerm_postgresql_flexible_server_database" "kindgi" {
  name      = var.database_name
  server_id = azurerm_postgresql_flexible_server.kindgi.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# ---- secrets ------------------------------------------------------------------

locals {
  # Secret names in the vault, by role. Each value is added out of band.
  server_secrets = {
    database_url     = "database-url"     # postgres://kindgiadmin:…@<server>.postgres.database.azure.com:5432/kindgi?sslmode=require
    api_token        = "api-token"        # KINDGI_API_TOKEN, the seeded bearer
    secrets_aad_key  = "secrets-aad-key"  # 32 random bytes, base64: KINDGI_SECRETS_AAD_KEY (read at a pinned version)
    public_token_key = "public-token-key" # Ed25519 PKCS#8 PEM, base64: KINDGI_PUBLIC_TOKEN_SIGNING_KEY
    license_key      = "license-key"      # KINDGI_LICENSE_KEY (kgi_lk_…), issued by Kindgi
    # 32 random bytes, base64: KINDGI_ERASURE_LEDGER_KEY, the erasure ledger's
    # keyed hash, so erasures replay after a backup restore (read at a pinned version).
    erasure_ledger_key = "erasure-ledger-key"
  }
  # export_signing = "secret": the export signing key, a PEM private key, base64.
  export_signing_secrets = var.export_signing == "secret" ? { export_signing_key = "export-signing-key" } : {}
  shared_secrets = {
    pack_service_token = "pack-service-token" # KINDGI_PACK_SERVICE_TOKEN, both services
  }

  # Versionless references: Container Apps picks up a new version within 30
  # minutes and restarts the revisions that read it (C-SEC-4). Two keys are
  # the exception, pinned to one version: the AAD key (C-SEC-3: a new
  # version would make every secret stored in Postgres unreadable) and the
  # erasure ledger's key (a new version would make the ledger unreplayable
  # after a restore).
  pinned_versions = {
    secrets_aad_key    = var.secrets_aad_key_version
    erasure_ledger_key = var.erasure_ledger_key_version
  }
  secret_ids = {
    for role, name in merge(local.server_secrets, local.export_signing_secrets, local.shared_secrets) :
    role => (
      contains(keys(local.pinned_versions), role)
      ? "${azurerm_key_vault.kindgi.vault_uri}secrets/${name}/${local.pinned_versions[role]}"
      : "${azurerm_key_vault.kindgi.vault_uri}secrets/${name}"
    )
  }

  secret_ids_by_name = {
    for role, name in merge(local.server_secrets, local.export_signing_secrets, local.shared_secrets) : name => local.secret_ids[role]
  }

  # The pack's own secrets (`secret_env` from `kindgi env plan`), one
  # container-app secret per env name.
  pack_secret_ids = {
    for env_name, ref in var.pack_secret_env :
    env_name => (
      ref.version == "latest"
      ? "${azurerm_key_vault.kindgi.vault_uri}secrets/${ref.secret}"
      : "${azurerm_key_vault.kindgi.vault_uri}secrets/${ref.secret}/${ref.version}"
    )
  }
  pack_secret_names = toset([for ref in values(var.pack_secret_env) : ref.secret])
}

# Who may read which secret: on each secret, never the whole vault. The
# grants are made in the services apply, once the operator has created the
# secrets they're on (C-SEC-2: each is readable by exactly the identities
# that use it; C-PK-6: the pack gets nothing of Kindgi's but the shared token).

resource "azurerm_role_assignment" "server_reads" {
  for_each             = merge(local.server_secrets, local.export_signing_secrets, local.shared_secrets)
  scope                = "${azurerm_key_vault.kindgi.id}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.server.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "pack_reads_token" {
  for_each             = local.shared_secrets
  scope                = "${azurerm_key_vault.kindgi.id}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.pack.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "pack_reads_its_secrets" {
  for_each             = local.pack_secret_names
  scope                = "${azurerm_key_vault.kindgi.id}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.pack.principal_id
  principal_type       = "ServicePrincipal"
}

# The grants reach Key Vault's data plane after a while; Container Apps
# reads the references when it creates a revision.
resource "time_sleep" "secret_grants" {
  create_duration = "60s"
  depends_on = [
    azurerm_role_assignment.server_reads,
    azurerm_role_assignment.pack_reads_token,
    azurerm_role_assignment.pack_reads_its_secrets,
    azurerm_role_assignment.server_signs_exports,
  ]
}
