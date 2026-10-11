# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

output "server_url" {
  description = "The Kindgi API (and /console)."
  value       = "https://${azurerm_container_app.server.ingress[0].fqdn}"
}

output "pack_service_url" {
  description = "The pack service's in-environment URL (the server's KINDGI_PACK_SERVICE_URL)."
  value       = "https://${azurerm_container_app.pack.ingress[0].fqdn}"
}

output "database_server_name" {
  description = "The PostgreSQL Flexible Server, for `az postgres flexible-server update --admin-password` (README, step 3)."
  value       = azurerm_postgresql_flexible_server.kindgi.name
}

output "database_fqdn" {
  description = "For the database URL: postgres://kindgiadmin:<password>@<this>:5432/<db>?sslmode=require. It resolves only inside the VNet."
  value       = azurerm_postgresql_flexible_server.kindgi.fqdn
}

output "database_admin_login" {
  description = "The login the runtime uses (azure_pg_admin, CREATEROLE, not a superuser)."
  value       = local.database_admin_login
}

output "key_vault_name" {
  description = "The vault the operator adds the secret values to (README, step 3)."
  value       = azurerm_key_vault.kindgi.name
}

output "key_id" {
  description = "The key that wraps Kindgi's secrets, without a version: the server's KINDGI_SECRETS_AZURE_KEY_ID."
  value       = azurerm_key_vault_key.secrets.versionless_id
}

output "secrets_to_fill" {
  description = "The secrets the operator creates in the vault before the services apply (README, step 3), plus the pack's own."
  value = sort(concat(
    values(local.server_secrets),
    values(local.shared_secrets),
    tolist(local.pack_secret_names),
  ))
}

output "image_registry" {
  description = "Where the runtime and pack images go."
  value       = azurerm_container_registry.images.login_server
}

output "identities" {
  description = "The two services' managed identities (client ids are what KINDGI_AZURE_CLIENT_ID takes; principal ids are for role assignments)."
  value = {
    server = {
      client_id    = azurerm_user_assigned_identity.server.client_id
      principal_id = azurerm_user_assigned_identity.server.principal_id
    }
    pack = {
      client_id    = azurerm_user_assigned_identity.pack.client_id
      principal_id = azurerm_user_assigned_identity.pack.principal_id
    }
  }
}

output "infrastructure_resource_group" {
  description = "The resource group Azure creates and manages for the Container Apps environment's infrastructure. It goes with the environment."
  value       = azurerm_container_app_environment.kindgi.infrastructure_resource_group_name
}

output "license_enroll_command" {
  description = "Run once, where you're signed in to Azure with access to the vault, to enroll this deployment for renewing its license key. Then add the line it prints at access.kindgi.com (or send it to Kindgi, for a production key)."
  value       = "kindgi license enroll --for <your GitHub login, or your license subject> --renewer ${local.license_renewer_ref}"
}

output "license_renew_command" {
  description = "Renews the license key by hand or from your own scheduler. With license_renewal_schedule set, the module's job runs it."
  value       = "kindgi license renew --key ${local.license_key_ref} --renewer ${local.license_renewer_ref}"
}
