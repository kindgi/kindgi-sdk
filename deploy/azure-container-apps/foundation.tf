# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The network, identities, logs, the image registry, Key Vault and the key
# that wraps Kindgi's secrets, and the Container Apps environment: what
# both services stand on.

data "azurerm_resource_group" "kindgi" {
  name = var.resource_group_name
}

data "azurerm_client_config" "current" {}

# Key Vault, Container Registry and PostgreSQL names are global.
resource "random_string" "suffix" {
  length  = 4
  upper   = false
  special = false
}

locals {
  location = coalesce(var.location, data.azurerm_resource_group.kindgi.location)
  tags     = merge(var.tags, { "kindgi:deployment" = var.name_prefix })
  suffix   = random_string.suffix.result

  # The new-VNet shape unless an existing environment subnet is given.
  new_vnet              = var.environment_subnet_id == ""
  environment_subnet_id = local.new_vnet ? azurerm_subnet.environment[0].id : var.environment_subnet_id
  database_subnet_id    = local.new_vnet ? azurerm_subnet.database[0].id : var.database_subnet_id
  database_dns_zone_id  = local.new_vnet ? azurerm_private_dns_zone.database[0].id : var.database_private_dns_zone_id
}

# ---- network (the new-VNet shape) -------------------------------------------
# C-PK-7: the environment sits in a subnet, so the pack's code reaches what
# that VNet reaches. PostgreSQL gets its own delegated subnet and a private
# DNS zone, with no public access (C-DB-5).

resource "azurerm_virtual_network" "kindgi" {
  count               = local.new_vnet ? 1 : 0
  name                = "${var.name_prefix}-vnet"
  location            = local.location
  resource_group_name = data.azurerm_resource_group.kindgi.name
  address_space       = [var.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "environment" {
  count                = local.new_vnet ? 1 : 0
  name                 = "${var.name_prefix}-aca"
  resource_group_name  = data.azurerm_resource_group.kindgi.name
  virtual_network_name = azurerm_virtual_network.kindgi[0].name
  address_prefixes     = [var.environment_subnet_cidr]

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "database" {
  count                = local.new_vnet ? 1 : 0
  name                 = "${var.name_prefix}-pg"
  resource_group_name  = data.azurerm_resource_group.kindgi.name
  virtual_network_name = azurerm_virtual_network.kindgi[0].name
  address_prefixes     = [var.database_subnet_cidr]

  delegation {
    name = "postgresql"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_private_dns_zone" "database" {
  count               = local.new_vnet ? 1 : 0
  name                = "${var.name_prefix}.private.postgres.database.azure.com"
  resource_group_name = data.azurerm_resource_group.kindgi.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "database" {
  count                = local.new_vnet ? 1 : 0
  name                 = "${var.name_prefix}-vnet"
  private_dns_zone_id  = azurerm_private_dns_zone.database[0].id
  virtual_network_id   = azurerm_virtual_network.kindgi[0].id
  registration_enabled = false
  tags                 = local.tags
}

# ---- identities ---------------------------------------------------------------
# C-RT-6, C-PK-6: each service runs as its own user-assigned identity, made
# here so its grants exist before the first revision (Container Apps checks
# registry pulls and Key Vault references when it creates one). No key files.

resource "azurerm_user_assigned_identity" "server" {
  name                = "${var.name_prefix}-server"
  location            = local.location
  resource_group_name = data.azurerm_resource_group.kindgi.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "pack" {
  name                = "${var.name_prefix}-pack"
  location            = local.location
  resource_group_name = data.azurerm_resource_group.kindgi.name
  tags                = local.tags
}

# ---- logs -----------------------------------------------------------------------
# C-OPS-1: the server's boot lines, read with `az containerapp logs show`.

resource "azurerm_log_analytics_workspace" "kindgi" {
  name                = "${var.name_prefix}-logs"
  location            = local.location
  resource_group_name = data.azurerm_resource_group.kindgi.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

# ---- images ---------------------------------------------------------------------
# One registry for the runtime image (mirrored from Quay, see the README) and
# the pack images `kindgi build` pushes. Both services pull with their own
# identities; the server also reads deployments' images with its identity
# (KINDGI_IMAGE_REGISTRY_AUTH=azure, C-IMG-2). No admin user, no passwords.

resource "azurerm_container_registry" "images" {
  name                   = "${replace(var.name_prefix, "-", "")}${local.suffix}"
  location               = local.location
  resource_group_name    = data.azurerm_resource_group.kindgi.name
  sku                    = "Basic"
  admin_enabled          = false
  anonymous_pull_enabled = false
  tags                   = local.tags
}

resource "azurerm_role_assignment" "server_pulls" {
  scope                = azurerm_container_registry.images.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.server.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "pack_pulls" {
  scope                = azurerm_container_registry.images.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.pack.principal_id
  principal_type       = "ServicePrincipal"
}

# ---- Key Vault: the secrets both services read, and the key that wraps Kindgi's --
# Azure RBAC on the data plane; a person adds every secret value (C-SEC-1:
# a Key Vault secret can't exist without a value, so the module creates the
# vault, the grants and the names, never a secret).

resource "azurerm_key_vault" "kindgi" {
  name                          = "${var.name_prefix}-${local.suffix}"
  location                      = local.location
  resource_group_name           = data.azurerm_resource_group.kindgi.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = var.key_vault_purge_protection
  soft_delete_retention_days    = var.key_vault_soft_delete_retention_days
  public_network_access_enabled = true # every call is checked against Entra RBAC; network rules are hardening (README)
  tags                          = local.tags
}

locals {
  key_vault_admins = toset(concat([data.azurerm_client_config.current.object_id], var.key_vault_admins))
}

# Whoever adds the secret values and manages the key.
resource "azurerm_role_assignment" "admins_manage_keys" {
  for_each             = local.key_vault_admins
  scope                = azurerm_key_vault.kindgi.id
  role_definition_name = "Key Vault Crypto Officer"
  principal_id         = each.value
}

resource "azurerm_role_assignment" "admins_manage_secrets" {
  for_each             = local.key_vault_admins
  scope                = azurerm_key_vault.kindgi.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
}

# A new role assignment takes a while to reach Key Vault's data plane.
resource "time_sleep" "key_vault_admins" {
  create_duration = "60s"
  depends_on      = [azurerm_role_assignment.admins_manage_keys, azurerm_role_assignment.admins_manage_secrets]
}

# C-SEC-3: KINDGI_SECRETS_BACKEND=postgres with KMS azure. Secrets set
# through the API are envelope-encrypted in Postgres; this key wraps their
# DEKs. A rotation adds a key version; each secret remembers the version
# that wrapped it, and old versions keep unwrapping.
resource "azurerm_key_vault_key" "secrets" {
  name         = "${var.name_prefix}-secrets"
  key_vault_id = azurerm_key_vault.kindgi.id
  key_type     = "RSA"
  key_size     = 3072
  key_opts     = ["wrapKey", "unwrapKey"]
  tags         = local.tags

  dynamic "rotation_policy" {
    for_each = var.key_rotation_days > 0 ? [var.key_rotation_days] : []
    content {
      automatic {
        time_after_creation = "P${rotation_policy.value}D"
      }
    }
  }

  depends_on = [time_sleep.key_vault_admins]
}

# The server wraps and unwraps with the key and reads its current version:
# exactly this role, on this key.
resource "azurerm_role_assignment" "server_wraps" {
  scope                = azurerm_key_vault_key.secrets.resource_versionless_id
  role_definition_name = "Key Vault Crypto Service Encryption User"
  principal_id         = azurerm_user_assigned_identity.server.principal_id
  principal_type       = "ServicePrincipal"
}

# ---- the Container Apps environment ---------------------------------------------
# A workload-profiles environment (Consumption) in the environment subnet.
# Azure creates a platform-managed resource group for its infrastructure
# next to yours (named here, so it's easy to find); it goes with the
# environment.

resource "azurerm_container_app_environment" "kindgi" {
  name                               = "${var.name_prefix}-env"
  location                           = local.location
  resource_group_name                = data.azurerm_resource_group.kindgi.name
  logs_destination                   = "log-analytics"
  log_analytics_workspace_id         = azurerm_log_analytics_workspace.kindgi.id
  infrastructure_subnet_id           = local.environment_subnet_id
  infrastructure_resource_group_name = "${data.azurerm_resource_group.kindgi.name}-${var.name_prefix}-infra"
  internal_load_balancer_enabled     = var.environment_internal
  tags                               = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}
