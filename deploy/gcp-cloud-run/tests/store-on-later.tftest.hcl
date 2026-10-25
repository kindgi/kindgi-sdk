# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# Turning the secrets store on later (secrets_backend "none" to "postgres"),
# step by step. Each run applies against a mock Google provider and keeps
# its state for the next, so the runs are in order: a deployment without a
# store, the targeted apply of what the store stands on, then the full
# apply, once the AAD-key secret has its first version (added outside
# Terraform) and secrets_aad_key_version names it. A file of its own, since
# module.tftest.hcl's runs are each from nothing.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
  mock_data "google_sql_database_instance" {
    defaults = {
      connection_name  = "acme-app-dev:northamerica-northeast2:kindgi-dev-restored"
      database_version = "POSTGRES_16"
      settings = [{
        ip_configuration = [{ ipv4_enabled = true }]
      }]
    }
  }
}

variables {
  project_id      = "acme-app-dev"
  region          = "northamerica-northeast2"
  name_prefix     = "kindgi-dev"
  kindgi_env      = "dev"
  server_image    = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  pack_image      = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/acme-app@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  seed_tenant_id  = "00000000-0000-0000-0000-000000000001"
  seed_user_id    = "00000000-0000-0000-0000-000000000002"
  secrets_backend = "postgres"
}

run "a_deployment_without_a_store" {
  command = apply

  variables {
    secrets_backend = "none"
  }

  assert {
    condition     = length(google_kms_key_ring.kindgi) == 0 && !contains(keys(google_secret_manager_secret.server), "secrets_aad_key")
    error_message = "Without a store there is no key ring and no AAD-key secret."
  }
}

# The server's next revision reads the AAD key's version, which doesn't
# exist yet: a full apply is refused until secrets_aad_key_version is set.
run "a_full_plan_before_the_key_has_a_version_is_refused" {
  command = plan

  expect_failures = [google_cloud_run_v2_service.server]
}

# Only what the store stands on, and no service, so the server's
# precondition isn't reached. Its asserts can name only what it applied:
# terraform test refuses a reference to anything the targets leave out.
run "the_targeted_apply_makes_what_the_store_stands_on" {
  command = apply

  plan_options {
    target = [
      google_project_service.apis,
      google_kms_crypto_key_iam_member.server_wraps,
      google_secret_manager_secret_iam_member.server_reads,
    ]
  }

  assert {
    condition     = contains(keys(google_project_service.apis), "cloudkms.googleapis.com")
    error_message = "The targeted apply turns Cloud KMS on."
  }
  assert {
    condition     = length(google_kms_key_ring.kindgi) == 1 && length(google_kms_crypto_key.secrets) == 1 && length(google_kms_crypto_key_iam_member.server_wraps) == 1
    error_message = "The targeted apply makes the key ring, the key and the server's grant on it."
  }
  assert {
    condition     = contains(keys(google_secret_manager_secret.server), "secrets_aad_key") && contains(keys(google_secret_manager_secret_iam_member.server_reads), "secrets_aad_key")
    error_message = "The targeted apply makes the AAD-key secret, which its first version is added to, and the server's read access to it."
  }
}

run "the_full_apply_turns_the_store_on" {
  command = apply

  variables {
    secrets_aad_key_version = "1"
  }

  assert {
    condition = length(setsubtract([
      "KINDGI_SECRETS_BACKEND=postgres",
      "KINDGI_SECRETS_BACKEND_KMS=gcp",
      "KINDGI_SECRETS_GCP_PROJECT_ID=acme-app-dev",
      "KINDGI_SECRETS_GCP_LOCATION_ID=northamerica-northeast2",
      "KINDGI_SECRETS_GCP_KEY_RING_ID=kindgi-dev",
      "KINDGI_SECRETS_GCP_KEY_ID=kindgi-dev-secrets",
      ], [
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : "${e.name}=${e.value}" if e.value != null
    ])) == 0
    error_message = "The server's new revision has the store's settings."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_SECRETS_AAD_KEY"
    ]) == "kindgi-dev-secrets-aad-key@1"
    error_message = "The server reads the AAD key at the version secrets_aad_key_version names."
  }
  assert {
    condition     = length(google_kms_crypto_key_iam_member.server_reads_key) == 1
    error_message = "After the full apply the server also has the grant on the key's metadata."
  }
}
