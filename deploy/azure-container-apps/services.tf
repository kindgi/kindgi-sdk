# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The two container apps: the pack service (runs the pack's code, reachable
# only inside the environment) and the server (the API, agent and flow
# execution).

# ---- the pack service ---------------------------------------------------------

resource "azurerm_container_app" "pack" {
  name                         = "${var.name_prefix}-pack"
  container_app_environment_id = azurerm_container_app_environment.kindgi.id
  resource_group_name          = data.azurerm_resource_group.kindgi.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.pack.id]
  }

  registry {
    server   = azurerm_container_registry.images.login_server
    identity = azurerm_user_assigned_identity.pack.id
  }

  secret {
    name                = "pack-service-token"
    key_vault_secret_id = local.secret_ids.pack_service_token
    identity            = azurerm_user_assigned_identity.pack.id
  }

  dynamic "secret" {
    for_each = local.pack_secret_ids
    content {
      name                = "pack-env-${lower(replace(secret.key, "_", "-"))}"
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.pack.id
    }
  }

  # C-PK-4: only apps in this environment reach it (the environment holds
  # Kindgi's two apps alone), and every call carries the pack token.
  ingress {
    external_enabled = false
    target_port      = 8080

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.pack_min_instances
    max_replicas = var.pack_max_instances

    http_scale_rule {
      name                = "concurrency"
      concurrent_requests = tostring(var.pack_concurrency)
    }

    container {
      name   = "pack"
      image  = var.pack_image
      cpu    = var.pack_cpu
      memory = var.pack_memory

      env {
        name        = "KINDGI_PACK_SERVICE_TOKEN"
        secret_name = "pack-service-token"
      }
      env {
        name  = "KINDGI_PACK_SERVICE_MAX_CONCURRENCY"
        value = tostring(var.pack_concurrency)
      }
      env {
        name  = "KINDGI_PACK_ENV_CHECK"
        value = "strict"
      }

      # The pack's declared env (`kindgi env plan --env <name>`): plain
      # values, then Key Vault references, read with this app's identity.
      dynamic "env" {
        for_each = var.pack_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.pack_secret_env
        content {
          name        = env.key
          secret_name = "pack-env-${lower(replace(env.key, "_", "-"))}"
        }
      }

      # Not ready until every module is loaded and every env.required name
      # is set: a revision missing one never takes traffic (C-PK-2).
      startup_probe {
        transport               = "HTTP"
        path                    = "/readyz"
        port                    = 8080
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 24
      }
      liveness_probe {
        transport        = "HTTP"
        path             = "/healthz"
        port             = 8080
        interval_seconds = 30
      }
    }
  }

  depends_on = [
    time_sleep.secret_grants,
    azurerm_role_assignment.pack_pulls,
  ]
}

# ---- the server ---------------------------------------------------------------

locals {
  server_secret_refs = merge({
    KINDGI_DATABASE_URL             = "database-url"
    KINDGI_API_TOKEN                = "api-token"
    KINDGI_SECRETS_AAD_KEY          = "secrets-aad-key"
    KINDGI_PUBLIC_TOKEN_SIGNING_KEY = "public-token-key"
    KINDGI_LICENSE_KEY              = "license-key"
    KINDGI_PACK_SERVICE_TOKEN       = "pack-service-token"
    KINDGI_ERASURE_LEDGER_KEY       = "erasure-ledger-key"
  }, var.export_signing == "secret" ? { KINDGI_EXPORT_SIGNING_KEY = "export-signing-key" } : {})
  server_env = merge(
    {
      KINDGI_ENV          = var.kindgi_env
      KINDGI_TENANT_ID    = var.seed_tenant_id
      KINDGI_SEED_USER_ID = var.seed_user_id

      # Secrets set through the API: envelope-encrypted in Postgres, the
      # DEKs wrapped by the Key Vault key (C-SEC-3).
      KINDGI_SECRETS_BACKEND      = "postgres"
      KINDGI_SECRETS_BACKEND_KMS  = "azure"
      KINDGI_SECRETS_AZURE_KEY_ID = azurerm_key_vault_key.secrets.versionless_id

      # The server's own identity, for the key and the registry.
      KINDGI_AZURE_CLIENT_ID = azurerm_user_assigned_identity.server.client_id

      # The pack service: its in-environment URL and the shared token.
      KINDGI_PACK_SERVICE_URL  = "https://${azurerm_container_app.pack.ingress[0].fqdn}"
      KINDGI_PACK_SERVICE_AUTH = "token"

      # Reading deployments' images with the server's identity (C-IMG-2).
      KINDGI_IMAGE_REGISTRY_HOST = azurerm_container_registry.images.login_server
      KINDGI_IMAGE_REGISTRY_AUTH = "azure"
    },
    var.pack_call_timeout_ms == null ? {} : { KINDGI_PACK_CALL_TIMEOUT_MS = tostring(var.pack_call_timeout_ms) },
    length(var.cors_origins) == 0 ? {} : { KINDGI_CORS_ORIGINS = join(",", var.cors_origins) },
    var.openfga_api_url == "" ? {} : { KINDGI_OPENFGA_API_URL = var.openfga_api_url },
    var.trusted_proxies == "" ? {} : { KINDGI_TRUSTED_PROXIES = var.trusted_proxies },
    # The key version's URL: the server reads the key at boot and signs there.
    var.export_signing == "kms" ? { KINDGI_EXPORT_SIGNING_KMS_KEY = azurerm_key_vault_key.exports[0].id } : {},
    var.public_url == "" ? {} : { KINDGI_PUBLIC_URL = var.public_url },
  )

  # Every name the module sets on the server (some only with an option on),
  # plus KINDGI_DEV: server_env and server_secret_env can't set these.
  server_module_env = setunion(keys(local.server_env), keys(local.server_secret_refs), [
    "KINDGI_CORS_ORIGINS", "KINDGI_DEV", "KINDGI_EXPORT_SIGNING_KEY", "KINDGI_EXPORT_SIGNING_KMS_KEY",
    "KINDGI_OPENFGA_API_URL", "KINDGI_PACK_CALL_TIMEOUT_MS", "KINDGI_PUBLIC_URL", "KINDGI_TRUSTED_PROXIES",
  ])
  server_extra_env = setunion(keys(var.server_env), keys(var.server_secret_env))
}

resource "azurerm_container_app" "server" {
  name                         = "${var.name_prefix}-server"
  container_app_environment_id = azurerm_container_app_environment.kindgi.id
  resource_group_name          = data.azurerm_resource_group.kindgi.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.server.id]
  }

  registry {
    server   = azurerm_container_registry.images.login_server
    identity = azurerm_user_assigned_identity.server.id
  }

  # Keys come as env vars from Key Vault, never as files (C-RT-7).
  dynamic "secret" {
    for_each = toset(values(local.server_secret_refs))
    content {
      name                = secret.value
      key_vault_secret_id = local.secret_ids_by_name[secret.value]
      identity            = azurerm_user_assigned_identity.server.id
    }
  }
  dynamic "secret" {
    for_each = local.server_extra_secret_ids
    content {
      name                = "server-env-${lower(replace(secret.key, "_", "-"))}"
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.server.id
    }
  }

  # C-NET-3: the API checks its bearer token on every route. On an internal
  # environment, "external" publishes the app at the VNet's load balancer
  # only.
  ingress {
    external_enabled = true
    target_port      = 4000

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }

    dynamic "ip_security_restriction" {
      for_each = var.server_ip_allowlist
      content {
        name             = "allow-${ip_security_restriction.key}"
        action           = "Allow"
        ip_address_range = ip_security_restriction.value
      }
    }
  }

  template {
    # C-RT-2, C-RT-3: always one replica. An idle replica keeps its CPU (the
    # idle rate is only billing), so runs started with wait:false and the
    # background work keep going between requests.
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "server"
      image  = var.server_image
      cpu    = var.server_cpu
      memory = var.server_memory

      dynamic "env" {
        for_each = local.server_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.server_secret_refs
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      # The operator's own settings (sign-in, among others): plain values,
      # then Key Vault references, read with the server's identity.
      dynamic "env" {
        for_each = var.server_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.server_secret_env
        content {
          name        = env.key
          secret_name = "server-env-${lower(replace(env.key, "_", "-"))}"
        }
      }

      # C-RT-4: a slow first start runs the migrations; up to 2 minutes.
      startup_probe {
        transport               = "HTTP"
        path                    = "/health"
        port                    = 4000
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 24
      }
      liveness_probe {
        transport        = "HTTP"
        path             = "/health"
        port             = 4000
        interval_seconds = 30
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.secrets_aad_key_version != ""
      error_message = "secrets_aad_key_version is needed for the services: the version `az keyvault secret set` printed for secrets-aad-key (README, step 3)."
    }
    precondition {
      condition     = var.erasure_ledger_key_version != ""
      error_message = "erasure_ledger_key_version is needed for the services: the version `az keyvault secret set` printed for erasure-ledger-key (README, step 3)."
    }
    precondition {
      condition     = length(setintersection(local.server_module_env, local.server_extra_env)) == 0
      error_message = "server_env and server_secret_env can't set a name this module sets itself (its variables do: public_url for KINDGI_PUBLIC_URL, trusted_proxies, cors_origins, ...), nor KINDGI_DEV, which is for `kindgi dev` only."
    }
    precondition {
      condition     = length(setintersection(keys(var.server_env), keys(var.server_secret_env))) == 0
      error_message = "A name is in both server_env and server_secret_env: keep it in one."
    }
    precondition {
      condition     = length(setintersection(local.server_extra_env, toset(["KINDGI_AUTH_SECRET", "KINDGI_AUTH_SECRET_PATH"]))) == 0 || var.public_url != ""
      error_message = "Sign-in with identity providers (KINDGI_AUTH_SECRET) needs public_url: the URL people open the console at, where identity providers send them back. The server won't start without it."
    }
  }

  depends_on = [
    time_sleep.secret_grants,
    azurerm_role_assignment.server_pulls,
    azurerm_role_assignment.server_wraps,
    azurerm_postgresql_flexible_server_configuration.extensions,
    azurerm_postgresql_flexible_server_database.kindgi,
  ]
}
