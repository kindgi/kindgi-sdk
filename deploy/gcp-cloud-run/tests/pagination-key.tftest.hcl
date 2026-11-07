# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The page-cursor key, step by step. Each run applies against a mock Google
# provider and keeps its state for the next, so the runs are in order: a
# deployment before the key has a version (a new one at its first apply, or
# one upgraded from a module copy before the key), the key at its first
# version, a rotation that keeps the version before it, and the apply that
# drops that one once its cursors are out of date. A file of its own, since
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

# The key's secret and the server's read access to it come first, and the
# server gets no key until pagination_key_version names a version: one the
# secret doesn't have yet would stop the server's new revision.
run "the_key_waits_for_its_version" {
  command = apply

  assert {
    condition     = google_secret_manager_secret.server["pagination_key"].secret_id == "kindgi-dev-pagination-key"
    error_message = "The page-cursor key's secret exists from the first apply, for the version the operator adds."
  }
  assert {
    condition     = contains(keys(google_secret_manager_secret_iam_member.server_reads), "pagination_key")
    error_message = "The server may read the page-cursor key's secret."
  }
  assert {
    condition     = contains(output.secrets_to_fill, "kindgi-dev-pagination-key")
    error_message = "The page-cursor key's secret is one the operator adds a version to."
  }
  assert {
    condition = length([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name
      if startswith(e.name, "KINDGI_PAGINATION_")
    ]) == 0
    error_message = "Without pagination_key_version, the server gets no page-cursor key and makes one at boot, as before the key."
  }
}

run "the_key_at_its_first_version" {
  command = apply

  variables {
    pagination_key_version = "1"
  }

  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_PAGINATION_KEY"
    ]) == "kindgi-dev-pagination-key@1"
    error_message = "The server reads the page-cursor key at the version pagination_key_version pins, so every instance and every revision has the same key."
  }
}

# A rotation: the new version seals, and the one before it, given through
# server_secret_env, still opens the cursors it sealed. The server reads the
# module's own secret already, so that entry gets no grant of its own: a
# second grant of the same role on the same secret would take the server's
# read of the new version away with it when the entry goes.
run "a_rotation_keeps_the_key_before" {
  command = apply

  variables {
    pagination_key_version = "2"
    server_secret_env = {
      KINDGI_PAGINATION_PREVIOUS_KEY = { secret = "kindgi-dev-pagination-key", version = "1" }
    }
  }

  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_PAGINATION_KEY"
    ]) == "kindgi-dev-pagination-key@2"
    error_message = "The new version is the key that seals."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_PAGINATION_PREVIOUS_KEY"
    ]) == "kindgi-dev-pagination-key@1"
    error_message = "The version before it still opens the cursors it sealed."
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.server_reads_its_secrets) == 0
    error_message = "The previous key in the module's own secret gets no second grant on it."
  }
}

run "after_the_rotation_the_key_before_goes" {
  command = apply

  variables {
    pagination_key_version = "2"
  }

  assert {
    condition = length([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name
      if e.name == "KINDGI_PAGINATION_PREVIOUS_KEY"
    ]) == 0
    error_message = "Without the entry, the server has no previous key."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_PAGINATION_KEY"
    ]) == "kindgi-dev-pagination-key@2"
    error_message = "The new version stays the key."
  }
  # The mock keeps no shared binding, so this holds with or without the
  # grant filter: the run before, with no second grant, is what guards it.
  assert {
    condition     = google_secret_manager_secret_iam_member.server_reads["pagination_key"].secret_id == google_secret_manager_secret.server["pagination_key"].id
    error_message = "The server's read access to the key's secret is still the module's own after the previous key goes."
  }
}
