# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# Kindgi on Azure Container Apps: the server, the pack service, PostgreSQL
# Flexible Server, and what they stand on, in one resource group you
# already have. See README.md.

terraform {
  # Write-only arguments (the database admin password never enters the
  # state or the plan) need Terraform 1.11.
  required_version = ">= 1.11"

  # Remote state in an Azure Storage container, configured at init (a
  # partial backend):
  #   terraform init -backend-config=resource_group_name=<rg> \
  #     -backend-config=storage_account_name=<account> \
  #     -backend-config=container_name=tfstate \
  #     -backend-config=key=<this deployment>.tfstate \
  #     -backend-config=use_azuread_auth=true
  # A deployment of its own: never share a key (or a root module) with the
  # app's own infrastructure. Its state holds that app's resources.
  backend "azurerm" {}

  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      # 5.9: destroying a container app or the environment no longer fails
      # while polling Azure's empty 204 after the delete succeeded.
      version = ">= 5.9, < 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7, < 4.0"
    }
    time = {
      source  = "hashicorp/time"
      version = ">= 0.12, < 1.0"
    }
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id

  # C-PLAT-1: a person registers the resource providers once per
  # subscription (README). The module never writes at the subscription
  # level.
  resource_provider_registrations = "none"

  features {
    key_vault {
      # Only with purge protection off (a sandbox): a destroyed vault is
      # purged, so its name is free again at once.
      purge_soft_delete_on_destroy    = var.key_vault_purge_on_destroy
      recover_soft_deleted_key_vaults = false
    }
  }
}
