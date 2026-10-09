# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The module against mocked providers: no Azure account, no network.
# `terraform test` from the module's directory. What it pins: the contract
# requirements the plan itself shows (CONTRACT ids in the run names), and
# every refusal the variables and preconditions make.

mock_provider "azurerm" {
  override_during = plan

  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id = "11111111-1111-1111-1111-111111111111"
      object_id = "22222222-2222-2222-2222-222222222222"
    }
  }
  mock_data "azurerm_resource_group" {
    defaults = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev"
      location = "canadacentral"
    }
  }
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12"
      vault_uri = "https://kindgi-ab12.vault.azure.net/"
    }
  }
  mock_resource "azurerm_key_vault_key" {
    defaults = {
      versionless_id          = "https://kindgi-ab12.vault.azure.net/keys/kindgi-secrets"
      resource_versionless_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12/keys/kindgi-secrets"
    }
  }
  mock_resource "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.ContainerRegistry/registries/kindgiab12"
      login_server = "kindgiab12.azurecr.io"
    }
  }
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/kindgi-server"
      principal_id = "33333333-3333-3333-3333-333333333333"
      client_id    = "44444444-4444-4444-4444-444444444444"
    }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.Network/virtualNetworks/kindgi-vnet"
    }
  }
  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.Network/virtualNetworks/kindgi-vnet/subnets/kindgi-aca"
    }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.Network/privateDnsZones/kindgi.private.postgres.database.azure.com"
    }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.OperationalInsights/workspaces/kindgi-logs"
    }
  }
  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.App/managedEnvironments/kindgi-env"
    }
  }
  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.DBforPostgreSQL/flexibleServers/kindgi-pg-ab12"
      fqdn = "kindgi-pg-ab12.postgres.database.azure.com"
    }
  }
}

# random runs for real: it is local, and mocks have no ephemeral resources
# (the database admin password) yet.
mock_provider "time" {}

variables {
  subscription_id            = "00000000-0000-0000-0000-000000000000"
  resource_group_name        = "acme-kindgi-dev"
  kindgi_env                 = "dev"
  server_image               = "kindgiab12.azurecr.io/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  pack_image                 = "kindgiab12.azurecr.io/acme-app@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  seed_tenant_id             = "00000000-0000-0000-0000-000000000001"
  seed_user_id               = "00000000-0000-0000-0000-000000000002"
  secrets_aad_key_version    = "0123456789abcdef0123456789abcdef"
  erasure_ledger_key_version = "fedcba9876543210fedcba9876543210"
  pack_secret_env = {
    ACME_API_KEY = { secret = "acme-api-key", version = "latest" }
  }
}

run "new_vnet_shape_meets_the_contract" {
  command = plan

  variables {
    tags = { "team:owner" = "platform", purpose = "kindgi-dev" }
  }

  # C-PK-7, C-DB-5: a VNet, the two delegated subnets, a private DNS zone.
  assert {
    condition     = length(azurerm_virtual_network.kindgi) == 1 && length(azurerm_subnet.environment) == 1 && length(azurerm_subnet.database) == 1
    error_message = "The new-VNet shape creates the VNet and both subnets."
  }
  assert {
    condition     = azurerm_postgresql_flexible_server.kindgi.public_network_access_enabled == false
    error_message = "C-DB-5: PostgreSQL has no public access."
  }
  # C-DB-1: pgvector is on the allowlist.
  assert {
    condition     = azurerm_postgresql_flexible_server_configuration.extensions.value == "VECTOR"
    error_message = "C-DB-1: azure.extensions allows VECTOR."
  }
  # C-RT-2, C-RT-3: one server replica, always on.
  assert {
    condition     = azurerm_container_app.server.template[0].min_replicas == 1 && azurerm_container_app.server.template[0].max_replicas == 1
    error_message = "C-RT-2/3: exactly one server replica."
  }
  # C-PK-4: the pack service is reachable only inside the environment.
  assert {
    condition     = azurerm_container_app.pack.ingress[0].external_enabled == false
    error_message = "C-PK-4: the pack service's ingress is environment-internal."
  }
  # C-SEC-3: the Key Vault key wraps Kindgi's secrets, by its versionless URL.
  assert {
    condition     = local.server_env.KINDGI_SECRETS_BACKEND_KMS == "azure" && local.server_env.KINDGI_SECRETS_AZURE_KEY_ID == "https://kindgi-ab12.vault.azure.net/keys/kindgi-secrets"
    error_message = "C-SEC-3: KMS azure with the key's versionless URL."
  }
  assert {
    condition     = azurerm_key_vault_key.secrets.key_type == "RSA" && toset(azurerm_key_vault_key.secrets.key_opts) == toset(["wrapKey", "unwrapKey"])
    error_message = "The key is RSA, for wrapKey/unwrapKey only."
  }
  # C-SEC-3 (pinned AAD key): the AAD key is read at its version, everything else versionless.
  assert {
    condition     = local.secret_ids.secrets_aad_key == "https://kindgi-ab12.vault.azure.net/secrets/secrets-aad-key/0123456789abcdef0123456789abcdef" && local.secret_ids.database_url == "https://kindgi-ab12.vault.azure.net/secrets/database-url"
    error_message = "The AAD key is pinned to its version; other secrets are versionless."
  }
  assert {
    condition     = local.secret_ids.erasure_ledger_key == "https://kindgi-ab12.vault.azure.net/secrets/erasure-ledger-key/fedcba9876543210fedcba9876543210"
    error_message = "The erasure ledger's key is pinned to its version."
  }
  # C-SEC-2, C-PK-6: grants are per secret; the pack reads the shared token and its own secrets only.
  assert {
    condition     = toset(keys(azurerm_role_assignment.pack_reads_its_secrets)) == toset(["acme-api-key"]) && length(azurerm_role_assignment.pack_reads_token) == 1
    error_message = "C-PK-6: the pack reads exactly the pack token and its own secrets."
  }
  assert {
    condition     = alltrue([for a in values(azurerm_role_assignment.server_reads) : a.role_definition_name == "Key Vault Secrets User"]) && length(azurerm_role_assignment.server_reads) == 7
    error_message = "C-SEC-2: the server reads its six secrets and the pack token, each on its own."
  }
  # C-IMG-2: the server reads deployments' images with its own identity.
  assert {
    condition     = local.server_env.KINDGI_IMAGE_REGISTRY_AUTH == "azure" && local.server_env.KINDGI_IMAGE_REGISTRY_HOST == "kindgiab12.azurecr.io"
    error_message = "C-IMG-2: registry auth azure, on the module's registry."
  }
  # C-RT-4, C-PK-2: the probes.
  assert {
    condition     = azurerm_container_app.server.template[0].container[0].startup_probe[0].path == "/health" && azurerm_container_app.pack.template[0].container[0].startup_probe[0].path == "/readyz"
    error_message = "C-RT-4/C-PK-2: startup probes on /health and /readyz."
  }
  # C-SEC-1: no secret has a value in the configuration.
  assert {
    condition     = alltrue([for s in azurerm_container_app.server.secret : s.value == null]) && alltrue([for s in azurerm_container_app.pack.secret : s.value == null])
    error_message = "C-SEC-1: every container-app secret is a Key Vault reference, never a value."
  }
  # The platform-managed infrastructure group has a name you can find.
  assert {
    condition     = azurerm_container_app_environment.kindgi.infrastructure_resource_group_name == "acme-kindgi-dev-kindgi-infra"
    error_message = "The infrastructure resource group is named <rg>-<prefix>-infra."
  }
  # Private DNS zones drop tag names with a colon (live, 2026-10-08): the
  # zone and its link get only the others, so a plan shows no change.
  assert {
    condition     = azurerm_private_dns_zone.database[0].tags == tomap({ purpose = "kindgi-dev", kindgi-deployment = "kindgi" }) && azurerm_private_dns_zone_virtual_network_link.database[0].tags == azurerm_private_dns_zone.database[0].tags
    error_message = "The DNS zone and its link carry only the tags without a colon."
  }
  assert {
    condition     = azurerm_virtual_network.kindgi[0].tags["team:owner"] == "platform"
    error_message = "Other resources keep every tag."
  }
  # PostgreSQL adds this endpoint to its subnet; declared, so a plan
  # doesn't try to remove it.
  assert {
    condition     = contains([for e in azurerm_subnet.database[0].service_endpoint : e.service], "Microsoft.Storage")
    error_message = "The database subnet declares the Microsoft.Storage endpoint PostgreSQL adds."
  }
}

run "existing_vnet_shape_creates_no_network" {
  command = plan

  variables {
    environment_subnet_id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/v/subnets/aca"
    database_subnet_id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/v/subnets/pg"
    database_private_dns_zone_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/privateDnsZones/kindgi.private.postgres.database.azure.com"
  }

  assert {
    condition     = length(azurerm_virtual_network.kindgi) == 0 && length(azurerm_private_dns_zone.database) == 0
    error_message = "The existing-VNet shape creates no network."
  }
  assert {
    condition     = azurerm_container_app_environment.kindgi.infrastructure_subnet_id == var.environment_subnet_id
    error_message = "The environment sits in the given subnet."
  }
}

run "existing_vnet_shape_needs_all_three" {
  command = plan
  variables {
    environment_subnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/v/subnets/aca"
  }
  expect_failures = [var.environment_subnet_id]
}

# Container Apps' ingress appends the client to X-Forwarded-For (live,
# 2026-10-08): one trusted hop by default, so rate limits see the client.
run "trusts_one_proxy_by_default" {
  command = plan
  assert {
    condition     = local.server_env.KINDGI_TRUSTED_PROXIES == "1"
    error_message = "The server trusts one hop: the Container Apps ingress."
  }
}

run "trusted_proxies_takes_ranges" {
  command = plan
  variables {
    trusted_proxies = "10.0.0.0/8, 2001:db8::/32"
  }
  assert {
    condition     = local.server_env.KINDGI_TRUSTED_PROXIES == "10.0.0.0/8, 2001:db8::/32"
    error_message = "IP/CIDR ranges pass through as given."
  }
}

run "empty_trusted_proxies_leaves_it_unset" {
  command = plan
  variables {
    trusted_proxies = ""
  }
  assert {
    condition     = !contains(keys(local.server_env), "KINDGI_TRUSTED_PROXIES")
    error_message = "An empty trusted_proxies sets nothing."
  }
}

# Exports are off unless asked for: no key, no secret, no setting.
run "exports_are_not_signed_by_default" {
  command = plan
  assert {
    condition     = length(azurerm_key_vault_key.exports) == 0 && !contains(keys(local.server_env), "KINDGI_EXPORT_SIGNING_KMS_KEY") && !contains(keys(local.server_secret_refs), "KINDGI_EXPORT_SIGNING_KEY")
    error_message = "export_signing = none sets up nothing."
  }
}

# export_signing = "kms": an EC P-256 key in the vault (Key Vault has no
# Ed25519), the server allowed to read it and sign, and its version's URL.
run "exports_signed_in_key_vault" {
  command = plan
  variables {
    export_signing = "kms"
  }
  assert {
    condition     = azurerm_key_vault_key.exports[0].key_type == "EC" && azurerm_key_vault_key.exports[0].curve == "P-256" && toset(azurerm_key_vault_key.exports[0].key_opts) == toset(["sign", "verify"])
    error_message = "The export key is an EC P-256 key that signs."
  }
  assert {
    condition     = azurerm_role_assignment.server_signs_exports[0].role_definition_name == "Key Vault Crypto User" && azurerm_role_assignment.server_signs_exports[0].scope == azurerm_key_vault_key.exports[0].resource_versionless_id
    error_message = "The server gets Key Vault Crypto User on that key, and nothing wider."
  }
  assert {
    condition     = local.server_env.KINDGI_EXPORT_SIGNING_KMS_KEY == azurerm_key_vault_key.exports[0].id && !contains(keys(local.server_secret_refs), "KINDGI_EXPORT_SIGNING_KEY")
    error_message = "The server signs with the key version, and reads no export key secret."
  }
}

# export_signing = "secret": a key the operator puts in the vault, read like the others.
run "exports_signed_with_a_secret" {
  command = plan
  variables {
    export_signing = "secret"
  }
  assert {
    condition     = local.server_secret_refs.KINDGI_EXPORT_SIGNING_KEY == "export-signing-key" && contains(keys(azurerm_role_assignment.server_reads), "export_signing_key") && length(azurerm_key_vault_key.exports) == 0
    error_message = "The server reads export-signing-key, granted on that secret alone."
  }
}

run "refuses_a_trusted_proxies_that_is_neither" {
  command = plan
  variables {
    trusted_proxies = "ingress"
  }
  expect_failures = [var.trusted_proxies]
}

run "refuses_a_pack_call_timeout_over_the_platform_cap" {
  command = plan
  variables {
    pack_call_timeout_ms = 300000
  }
  expect_failures = [var.pack_call_timeout_ms]
}

run "refuses_an_image_without_a_digest" {
  command = plan
  variables {
    server_image = "kindgiab12.azurecr.io/runtime:0.1.6"
  }
  expect_failures = [var.server_image]
}

run "refuses_a_gcp_project_in_pack_secret_env" {
  command = plan
  variables {
    pack_secret_env = {
      ACME_API_KEY = { secret = "acme-api-key", version = "latest", project = "acme-gcp" }
    }
  }
  expect_failures = [var.pack_secret_env]
}

run "the_services_need_the_aad_key_version" {
  command = plan
  variables {
    secrets_aad_key_version = ""
  }
  expect_failures = [azurerm_container_app.server]
}

run "the_services_need_the_erasure_ledger_key_version" {
  command = plan
  variables {
    erasure_ledger_key_version = ""
  }
  expect_failures = [azurerm_container_app.server]
}

# The server's own settings (sign-in, among others), as the Cloud Run module
# takes them: plain values, then Key Vault references the server alone reads.
run "server_settings_plain_and_by_reference" {
  command = plan
  variables {
    public_url = "https://kindgi.acme.example"
    server_env = {
      KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
      KINDGI_AUTH_EMAIL_FROM       = "kindgi@acme.example"
    }
    server_secret_env = {
      KINDGI_AUTH_SECRET         = { secret = "auth-secret", version = "0123456789abcdef0123456789abcdef" }
      KINDGI_AUTH_EMAIL_SMTP_URL = { secret = "smtp-url", version = "latest" }
    }
  }
  assert {
    condition     = local.server_env.KINDGI_PUBLIC_URL == "https://kindgi.acme.example"
    error_message = "public_url sets KINDGI_PUBLIC_URL."
  }
  assert {
    condition     = toset([for e in azurerm_container_app.server.template[0].container[0].env : "${e.name}=${e.value}" if contains(["KINDGI_CONSOLE_TOKEN_SIGN_IN", "KINDGI_AUTH_EMAIL_FROM"], e.name)]) == toset(["KINDGI_CONSOLE_TOKEN_SIGN_IN=on", "KINDGI_AUTH_EMAIL_FROM=kindgi@acme.example"])
    error_message = "server_env's plain values reach the server."
  }
  assert {
    condition     = toset([for e in azurerm_container_app.server.template[0].container[0].env : "${e.name}>${e.secret_name}" if contains(["KINDGI_AUTH_SECRET", "KINDGI_AUTH_EMAIL_SMTP_URL"], e.name)]) == toset(["KINDGI_AUTH_SECRET>server-env-kindgi-auth-secret", "KINDGI_AUTH_EMAIL_SMTP_URL>server-env-kindgi-auth-email-smtp-url"])
    error_message = "server_secret_env's names read container-app secrets."
  }
  assert {
    condition     = toset([for s in azurerm_container_app.server.secret : "${s.name}=${s.key_vault_secret_id}" if startswith(s.name, "server-env-")]) == toset(["server-env-kindgi-auth-secret=https://kindgi-ab12.vault.azure.net/secrets/auth-secret/0123456789abcdef0123456789abcdef", "server-env-kindgi-auth-email-smtp-url=https://kindgi-ab12.vault.azure.net/secrets/smtp-url"])
    error_message = "Each is a Key Vault reference: pinned at a version, or without one for latest."
  }
  assert {
    condition     = toset([for a in values(azurerm_role_assignment.server_reads_its_secrets) : a.scope]) == toset(["/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12/secrets/auth-secret", "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12/secrets/smtp-url"]) && !contains([for a in values(azurerm_role_assignment.pack_reads_its_secrets) : a.scope], "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12/secrets/auth-secret")
    error_message = "The server reads exactly those secrets; the pack doesn't."
  }
}

run "no_public_url_by_default" {
  command = plan
  assert {
    condition     = !contains(keys(local.server_env), "KINDGI_PUBLIC_URL") && length(azurerm_role_assignment.server_reads_its_secrets) == 0
    error_message = "No public_url, no server settings: nothing set, nothing granted."
  }
}

run "refuses_a_public_url_with_a_path" {
  command = plan
  variables {
    public_url = "https://kindgi.acme.example/console"
  }
  expect_failures = [var.public_url]
}

run "refuses_a_secret_as_a_plain_value" {
  command = plan
  variables {
    server_env = { KINDGI_AUTH_GOOGLE_CLIENT_SECRET = "oops" }
  }
  expect_failures = [var.server_env]
}

run "refuses_a_gcp_project_in_server_secret_env" {
  command = plan
  variables {
    server_secret_env = { KINDGI_AUTH_SECRET = { secret = "auth-secret", version = "latest", project = "acme" } }
    public_url        = "https://kindgi.acme.example"
  }
  expect_failures = [var.server_secret_env]
}

run "refuses_a_name_the_module_sets" {
  command = plan
  variables {
    server_env = { KINDGI_TRUSTED_PROXIES = "2" }
  }
  expect_failures = [azurerm_container_app.server]
}

run "refuses_kindgi_dev" {
  command = plan
  variables {
    server_env = { KINDGI_DEV = "true" }
  }
  expect_failures = [azurerm_container_app.server]
}

run "refuses_a_name_in_both_maps" {
  command = plan
  variables {
    server_env        = { KINDGI_AUTH_EMAIL_FROM = "kindgi@acme.example" }
    server_secret_env = { KINDGI_AUTH_EMAIL_FROM = { secret = "from", version = "latest" } }
  }
  expect_failures = [azurerm_container_app.server]
}

run "sign_in_with_providers_needs_public_url" {
  command = plan
  variables {
    server_secret_env = { KINDGI_AUTH_SECRET = { secret = "auth-secret", version = "latest" } }
  }
  expect_failures = [azurerm_container_app.server]
}

# Renewing the license key: off by default. The server still gets where the
# two keys are, so its 30-day warning prints the exact command.
run "license_renewal_is_off_by_default" {
  command = plan
  assert {
    condition     = length(azurerm_container_app_job.license_renewal) == 0 && length(azurerm_user_assigned_identity.license_renewer) == 0 && length(azurerm_role_definition.license_key_writer) == 0 && length(azurerm_role_assignment.license_renewer_reads) == 0 && length(azurerm_monitor_metric_alert.license_renewal_failed) == 0 && length(azurerm_monitor_scheduled_query_rules_alert_v2.license_key_expiring) == 0
    error_message = "No schedule: no job, no renewer identity, no grants, no alerts."
  }
  assert {
    condition     = local.server_env.KINDGI_LICENSE_KEY_REF == "azure:https://kindgi-ab12.vault.azure.net/secrets/license-key" && local.server_env.KINDGI_LICENSE_RENEWER_REF == "azure:https://kindgi-ab12.vault.azure.net/secrets/license-renewer"
    error_message = "The server knows where the license key and the renewer key are."
  }
  assert {
    condition     = output.license_renew_command == "kindgi license renew --key azure:https://kindgi-ab12.vault.azure.net/secrets/license-key --renewer azure:https://kindgi-ab12.vault.azure.net/secrets/license-renewer" && strcontains(output.license_enroll_command, "kindgi license enroll --for <") && endswith(output.license_enroll_command, "--renewer azure:https://kindgi-ab12.vault.azure.net/secrets/license-renewer")
    error_message = "The outputs give the enroll and renew commands with the refs filled in."
  }
}

# On a schedule: the runtime image runs `kindgi license renew` as an identity
# of its own, which reads the two secrets and may only set the license key.
run "license_renewal_on_a_schedule" {
  command = plan
  variables {
    license_renewal_schedule = "17 6 * * *"
  }
  # Its own identity, told apart from the server's.
  override_resource {
    target          = azurerm_user_assigned_identity.license_renewer
    override_during = plan
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/kindgi-license-renewer"
      principal_id = "55555555-5555-5555-5555-555555555555"
      client_id    = "66666666-6666-6666-6666-666666666666"
    }
  }
  assert {
    condition     = azurerm_container_app_job.license_renewal[0].schedule_trigger_config[0].cron_expression == "17 6 * * *" && azurerm_container_app_job.license_renewal[0].template[0].container[0].image == var.server_image
    error_message = "The job runs the server's image on the schedule."
  }
  assert {
    condition     = azurerm_container_app_job.license_renewal[0].template[0].container[0].command == tolist(["kindgi"]) && azurerm_container_app_job.license_renewal[0].template[0].container[0].args == tolist(["license", "renew", "--key", "azure:https://kindgi-ab12.vault.azure.net/secrets/license-key", "--renewer", "azure:https://kindgi-ab12.vault.azure.net/secrets/license-renewer"])
    error_message = "It runs kindgi license renew with the two refs."
  }
  assert {
    condition     = one([for e in azurerm_container_app_job.license_renewal[0].template[0].container[0].env : e.value if e.name == "KINDGI_AZURE_CLIENT_ID"]) == "66666666-6666-6666-6666-666666666666" && toset(azurerm_container_app_job.license_renewal[0].identity[0].identity_ids) == toset(["/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/kindgi-license-renewer"]) && alltrue([for a in values(azurerm_role_assignment.license_renewer_reads) : a.principal_id == "55555555-5555-5555-5555-555555555555"]) && azurerm_role_assignment.license_renewer_writes_key[0].principal_id == "55555555-5555-5555-5555-555555555555"
    error_message = "It signs in to Key Vault as its own identity, and the grants are that identity's."
  }
  assert {
    condition     = toset([for k, a in azurerm_role_assignment.license_renewer_reads : a.scope]) == toset(["/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12/secrets/license-key", "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12/secrets/license-renewer"]) && alltrue([for a in values(azurerm_role_assignment.license_renewer_reads) : a.role_definition_name == "Key Vault Secrets User"])
    error_message = "It reads the license key and the renewer key, on those two secrets only."
  }
  assert {
    condition     = azurerm_role_definition.license_key_writer[0].permissions[0].data_actions == toset(["Microsoft.KeyVault/vaults/secrets/setSecret/action"]) && (azurerm_role_definition.license_key_writer[0].permissions[0].actions == null || length(coalesce(azurerm_role_definition.license_key_writer[0].permissions[0].actions, [])) == 0) && azurerm_role_assignment.license_renewer_writes_key[0].scope == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12/secrets/license-key"
    error_message = "It may set the license key and nothing else: no delete, no other secret."
  }
  assert {
    condition     = !contains([for k, a in azurerm_role_assignment.server_reads : a.scope], "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12/secrets/license-renewer")
    error_message = "The server never reads the renewer key."
  }
}

run "license_renewer_secret_of_your_own_name" {
  command = plan
  variables {
    license_renewal_schedule = "0 3 * * 1"
    license_renewer_secret   = "kindgi-renewer"
  }
  assert {
    condition     = local.server_env.KINDGI_LICENSE_RENEWER_REF == "azure:https://kindgi-ab12.vault.azure.net/secrets/kindgi-renewer" && contains(keys(azurerm_role_assignment.license_renewer_reads), "renewer") && azurerm_role_assignment.license_renewer_reads["renewer"].scope == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-kindgi-dev/providers/Microsoft.KeyVault/vaults/kindgi-ab12/secrets/kindgi-renewer"
    error_message = "license_renewer_secret names the renewer key's secret everywhere."
  }
}

run "refuses_a_schedule_that_isnt_cron" {
  command = plan
  variables {
    license_renewal_schedule = "daily"
  }
  expect_failures = [var.license_renewal_schedule]
}

run "refuses_a_renewer_secret_the_module_uses" {
  command = plan
  variables {
    license_renewer_secret = "license-key"
  }
  expect_failures = [azurerm_container_app.server]
}

run "refuses_the_license_refs_in_server_env" {
  command = plan
  variables {
    server_env = { KINDGI_LICENSE_RENEWER_REF = "azure:https://elsewhere.vault.azure.net/secrets/x" }
  }
  expect_failures = [azurerm_container_app.server]
}

# The job's two alerts: a failed execution, and the run line saying the key
# expires within a week. With action groups, both go there.
run "license_renewal_alerts" {
  command = plan
  variables {
    license_renewal_schedule = "17 6 * * *"
    alert_action_groups      = ["/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-ops/providers/microsoft.insights/actionGroups/oncall"]
  }
  assert {
    condition     = azurerm_monitor_metric_alert.license_renewal_failed[0].criteria[0].metric_namespace == "Microsoft.App/jobs" && azurerm_monitor_metric_alert.license_renewal_failed[0].criteria[0].metric_name == "Executions" && azurerm_monitor_metric_alert.license_renewal_failed[0].criteria[0].dimension[0].name == "state" && azurerm_monitor_metric_alert.license_renewal_failed[0].criteria[0].dimension[0].values == tolist(["Failed"])
    error_message = "A failed execution of the job alerts."
  }
  assert {
    condition     = strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.license_key_expiring[0].criteria[0].query, "== \"kindgi-license-renew\"") && strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.license_key_expiring[0].criteria[0].query, "It expires in (-[0-9]+|[0-6]) days") && azurerm_monitor_scheduled_query_rules_alert_v2.license_key_expiring[0].scopes == tolist([azurerm_log_analytics_workspace.kindgi.id])
    error_message = "The job's run line saying the key expires within a week alerts, from the environment's workspace."
  }
  assert {
    condition     = toset([for a in azurerm_monitor_metric_alert.license_renewal_failed[0].action : a.action_group_id]) == toset(var.alert_action_groups) && toset(azurerm_monitor_scheduled_query_rules_alert_v2.license_key_expiring[0].action[0].action_groups) == toset(var.alert_action_groups)
    error_message = "Both go to the action groups."
  }
}

run "refuses_an_action_group_that_isnt_an_id" {
  command = plan
  variables {
    alert_action_groups = ["oncall"]
  }
  expect_failures = [var.alert_action_groups]
}
