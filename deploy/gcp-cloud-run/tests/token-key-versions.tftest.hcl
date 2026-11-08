# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The API token and the public run token key, at the versions
# api_token_version and public_token_key_version pin: unset, the server reads
# `latest`, as before the variables; set, it reads that version, and so does
# the command the orchestrator_key_steps output prints; `latest` and a version
# 0 are refused. The first two runs apply against a mock Google provider, and
# the last two plan.

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

# The pack account as Google names it: the orchestrator's grant to act as it
# takes only that form, which the mock's own random name isn't.
override_resource {
  target = google_service_account.pack
  values = {
    name  = "projects/acme-app-dev/serviceAccounts/kindgi-dev-pack@acme-app-dev.iam.gserviceaccount.com"
    email = "kindgi-dev-pack@acme-app-dev.iam.gserviceaccount.com"
  }
}

variables {
  project_id              = "acme-app-dev"
  region                  = "northamerica-northeast2"
  name_prefix             = "kindgi-dev"
  kindgi_env              = "dev"
  server_image            = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  seed_tenant_id          = "00000000-0000-0000-0000-000000000001"
  seed_user_id            = "00000000-0000-0000-0000-000000000002"
  secrets_aad_key_version = "1"
}

run "unset_reads_latest" {
  command = apply

  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_API_TOKEN"
    ]) == "kindgi-dev-api-token@latest"
    error_message = "Without api_token_version, the server reads the API token at latest, as before the variable."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_PUBLIC_TOKEN_SIGNING_KEY"
    ]) == "kindgi-dev-public-token-key@latest"
    error_message = "Without public_token_key_version, the server reads the public token key at latest, as before the variable."
  }
  assert {
    condition     = strcontains(output.orchestrator_key_steps, "gcloud secrets versions access latest --secret=kindgi-dev-api-token")
    error_message = "Without api_token_version, the printed mint command reads the API token at latest."
  }
}

run "pinned_reads_the_version" {
  command = apply

  variables {
    api_token_version        = "3"
    public_token_key_version = "2"
  }

  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_API_TOKEN"
    ]) == "kindgi-dev-api-token@3"
    error_message = "The server reads the API token at the version api_token_version pins, so every instance holds the same token."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_PUBLIC_TOKEN_SIGNING_KEY"
    ]) == "kindgi-dev-public-token-key@2"
    error_message = "The server reads the public token key at the version public_token_key_version pins, so every instance accepts the tokens another signed."
  }
  assert {
    condition     = strcontains(output.orchestrator_key_steps, "gcloud secrets versions access 3 --secret=kindgi-dev-api-token")
    error_message = "The printed mint command reads the API token at the version the server holds."
  }
}

run "the_api_token_version_is_never_latest" {
  command = plan

  variables {
    api_token_version = "latest"
  }

  expect_failures = [var.api_token_version]
}

run "the_public_token_key_version_is_a_version_number" {
  command = plan

  variables {
    public_token_key_version = "0"
  }

  expect_failures = [var.public_token_key_version]
}
