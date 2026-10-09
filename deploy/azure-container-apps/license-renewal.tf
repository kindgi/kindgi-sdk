# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# Renewing the license key from this deployment, if you turn it on: off by
# default, and then nothing here calls Kindgi.
#
# With `license_renewal_schedule` set, a Container Apps job runs the
# runtime image as `kindgi license renew` on that schedule. It asks
# access.kindgi.com for the deployment's key, proving who it is with the
# renewer key `kindgi license enroll` put in the vault, checks the answer
# offline, and adds it to `license-key` only when it changed. The server
# picks it up when it next starts. The job has an identity of its own: it
# reads the two secrets, and may set only the license key, never delete it.

locals {
  license_renewal        = var.license_renewal_schedule != ""
  license_renewer_secret = coalesce(var.license_renewer_secret, "license-renewer")

  # Where the key and the renewer key live, as `kindgi license` names them.
  license_key_ref     = "azure:${azurerm_key_vault.kindgi.vault_uri}secrets/${local.server_secrets.license_key}"
  license_renewer_ref = "azure:${azurerm_key_vault.kindgi.vault_uri}secrets/${local.license_renewer_secret}"
}

resource "azurerm_user_assigned_identity" "license_renewer" {
  count               = local.license_renewal ? 1 : 0
  name                = "${var.name_prefix}-license-renewer"
  location            = local.location
  resource_group_name = data.azurerm_resource_group.kindgi.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "license_renewer_pulls" {
  count                = local.license_renewal ? 1 : 0
  scope                = azurerm_container_registry.images.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.license_renewer[0].principal_id
  principal_type       = "ServicePrincipal"
}

# Reading: the renewer key (to sign its request) and the license key (to
# check a new one is for the same holder and expires no earlier). The
# grants are on the two secrets, in the services apply: the renewer key
# exists once `kindgi license enroll` has run (README, "Renewing the
# license key").
resource "azurerm_role_assignment" "license_renewer_reads" {
  for_each = local.license_renewal ? {
    license_key = local.server_secrets.license_key
    renewer     = local.license_renewer_secret
  } : {}
  scope                = "${azurerm_key_vault.kindgi.id}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.license_renewer[0].principal_id
  principal_type       = "ServicePrincipal"
}

# Writing: a version of the license key, and nothing else. Key Vault
# Secrets Officer could also delete it, so a role of its own with only
# setSecret, assigned on that one secret.
resource "azurerm_role_definition" "license_key_writer" {
  count       = local.license_renewal ? 1 : 0
  name        = "${var.name_prefix}-license-key-writer-${local.suffix}"
  scope       = data.azurerm_resource_group.kindgi.id
  description = "Adds a version of the Kindgi license key secret; can't read, list or delete secrets."

  permissions {
    data_actions = ["Microsoft.KeyVault/vaults/secrets/setSecret/action"]
  }

  assignable_scopes = [data.azurerm_resource_group.kindgi.id]
}

resource "azurerm_role_assignment" "license_renewer_writes_key" {
  count              = local.license_renewal ? 1 : 0
  scope              = "${azurerm_key_vault.kindgi.id}/secrets/${local.server_secrets.license_key}"
  role_definition_id = azurerm_role_definition.license_key_writer[0].role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.license_renewer[0].principal_id
  principal_type     = "ServicePrincipal"
}

resource "time_sleep" "license_renewer_grants" {
  count           = local.license_renewal ? 1 : 0
  create_duration = "60s"
  depends_on = [
    azurerm_role_assignment.license_renewer_pulls,
    azurerm_role_assignment.license_renewer_reads,
    azurerm_role_assignment.license_renewer_writes_key,
  ]
}

resource "azurerm_container_app_job" "license_renewal" {
  count                        = local.license_renewal ? 1 : 0
  name                         = "${var.name_prefix}-license-renew"
  location                     = local.location
  resource_group_name          = data.azurerm_resource_group.kindgi.name
  container_app_environment_id = azurerm_container_app_environment.kindgi.id
  workload_profile_name        = "Consumption"
  # One try, retried once: a renewal that fails today has the next day,
  # and 30 days before the key expires (plus 14 of grace).
  replica_timeout_in_seconds = 300
  replica_retry_limit        = 1
  tags                       = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.license_renewer[0].id]
  }

  registry {
    server   = azurerm_container_registry.images.login_server
    identity = azurerm_user_assigned_identity.license_renewer[0].id
  }

  schedule_trigger_config {
    cron_expression          = var.license_renewal_schedule
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "license-renew"
      image   = var.server_image
      cpu     = 0.25
      memory  = "0.5Gi"
      command = ["kindgi"]
      args    = ["license", "renew", "--key", local.license_key_ref, "--renewer", local.license_renewer_ref]

      # The job's own identity, for Key Vault.
      env {
        name  = "KINDGI_AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.license_renewer[0].client_id
      }
    }
  }

  depends_on = [time_sleep.license_renewer_grants]
}

# ---- alerts, with the job on ------------------------------------------------------
# Two alerts, sent to `alert_action_groups` (none: they fire in Azure
# Monitor only): a renewal that failed, and a key that expires within a
# week, which `kindgi license renew` says on every run ("⚠ It expires in N
# days"; a CLI test pins that line).

resource "azurerm_monitor_metric_alert" "license_renewal_failed" {
  count               = local.license_renewal ? 1 : 0
  name                = "${var.name_prefix}-license-renewal-failed"
  resource_group_name = data.azurerm_resource_group.kindgi.name
  scopes              = [azurerm_container_app_job.license_renewal[0].id]
  description         = "The license key's renewal job failed. Its runs: az containerapp job execution list -n ${var.name_prefix}-license-renew -g ${data.azurerm_resource_group.kindgi.name}"
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.App/jobs"
    metric_name      = "Executions"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 0

    dimension {
      name     = "state"
      operator = "Include"
      values   = ["Failed"]
    }
  }

  dynamic "action" {
    for_each = var.alert_action_groups
    content {
      action_group_id = action.value
    }
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "license_key_expiring" {
  count                = local.license_renewal ? 1 : 0
  name                 = "${var.name_prefix}-license-key-expiring"
  resource_group_name  = data.azurerm_resource_group.kindgi.name
  location             = local.location
  scopes               = [azurerm_log_analytics_workspace.kindgi.id]
  description          = "The license key expires within 7 days, and renewing hasn't brought a new one: see the renewal job's last run."
  severity             = 2
  evaluation_frequency = "P1D"
  window_duration      = "P1D"
  # The console log table appears once something has logged.
  skip_query_validation = true
  tags                  = local.tags

  criteria {
    query                   = <<-KQL
      ContainerAppConsoleLogs_CL
      | where column_ifexists("ContainerJobName_s", "") == "${var.name_prefix}-license-renew"
      | where Log_s matches regex @"It expires in (-[0-9]+|[0-6]) days"
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }

  dynamic "action" {
    for_each = length(var.alert_action_groups) == 0 ? [] : [var.alert_action_groups]
    content {
      action_groups = action.value
    }
  }
}
