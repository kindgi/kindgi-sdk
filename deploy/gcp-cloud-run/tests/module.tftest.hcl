# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The module's own tests: `terraform init -backend=false && terraform test`
# in this folder. A mock Google provider, so no credentials and no calls:
# each run plans and checks what the module would create.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
  # Private-IP mode's CAs: the one in use, and one added for a rotation.
  mock_data "google_sql_ca_certs" {
    defaults = {
      certs = [
        { cert = "-----BEGIN CERTIFICATE-----\nacme in use\n-----END CERTIFICATE-----\n" },
        { cert = "-----BEGIN CERTIFICATE-----\nacme upcoming\n-----END CERTIFICATE-----\n" },
      ]
    }
  }
  # Stands in for a restore instance (database_instance) and a host instance
  # (database_host_instance): a public IP, Postgres 16.
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
  project_id              = "acme-app-dev"
  region                  = "northamerica-northeast2"
  name_prefix             = "kindgi-dev"
  kindgi_env              = "dev"
  server_image            = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  seed_tenant_id          = "00000000-0000-0000-0000-000000000001"
  seed_user_id            = "00000000-0000-0000-0000-000000000002"
  secrets_aad_key_version = "1"
}

run "defaults_keep_kms_and_the_own_repository" {
  command = plan

  assert {
    condition     = google_kms_crypto_key.secrets.name == "kindgi-dev-secrets" && google_kms_key_ring.kindgi.name == "kindgi-dev"
    error_message = "The module has its KMS key ring and key."
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name], "KINDGI_PACK_ENDPOINT_KMS_KEY")
    error_message = "The server seals each endpoint's token under the module's key, with the postgres secrets backend too."
  }
  assert {
    condition     = contains(keys(google_secret_manager_secret.server), "secrets_aad_key")
    error_message = "The default secrets backend has an AAD-key secret."
  }
  assert {
    condition     = length(google_artifact_registry_repository.images) == 1
    error_message = "Without image_repository, the module creates its own repository."
  }
  assert {
    condition     = length(google_artifact_registry_repository_iam_member.run_agent_pulls_images) == 0
    error_message = "The module's own repository needs no cross-project pull grant."
  }
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.pack_invokes) == 0
    error_message = "Without pack_run_invokers, the pack may invoke no other service."
  }
  assert {
    condition     = contains(keys(google_project_service.apis), "cloudresourcemanager.googleapis.com")
    error_message = "The module turns Cloud Resource Manager on, for a root beside it that reads the project billed to the project."
  }
}

run "secrets_backend_none_seals_endpoint_tokens_under_the_key" {
  command = plan

  variables {
    secrets_backend         = "none"
    secrets_aad_key_version = null
  }

  assert {
    condition     = google_kms_crypto_key.secrets.name == "kindgi-dev-secrets"
    error_message = "secrets_backend = none still has the KMS key: each pack endpoint's token is sealed under it."
  }
  assert {
    condition     = google_kms_crypto_key_iam_member.server_wraps.role == "roles/cloudkms.cryptoKeyEncrypterDecrypter"
    error_message = "secrets_backend = none still lets the server seal and open with the key."
  }
  assert {
    condition     = contains(keys(google_project_service.apis), "cloudkms.googleapis.com")
    error_message = "Cloud KMS is on whatever the secrets backend."
  }
  assert {
    condition     = !contains(keys(google_secret_manager_secret.server), "secrets_aad_key")
    error_message = "secrets_backend = none has no AAD-key secret."
  }
  assert {
    condition = length([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name
      if startswith(e.name, "KINDGI_SECRETS_")
    ]) == 0
    error_message = "secrets_backend = none sets no KINDGI_SECRETS_* variable on the server."
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name], "KINDGI_PACK_ENDPOINT_KMS_KEY")
    error_message = "secrets_backend = none still names the key the server seals endpoint tokens under."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_ENV_CLOUD_SECRETS"
    ]) == "on"
    error_message = "secrets_backend = none still takes cloud secrets in a pack's env."
  }
}

run "postgres_needs_the_aad_key_version" {
  command = plan

  variables {
    secrets_aad_key_version = null
  }

  expect_failures = [google_cloud_run_v2_service.server]
}

# The seed ids are uuids, as the server's settings are: another is refused
# at plan, not at the server's start. The check is the server's own (8-4-4-4-12
# hex digits, in either case), so a plan never refuses an id the server takes.
run "a_seed_tenant_id_that_isnt_a_uuid_is_refused" {
  command = plan

  variables {
    seed_tenant_id = "acme"
  }

  expect_failures = [var.seed_tenant_id]
}

run "a_seed_user_id_that_isnt_a_uuid_is_refused" {
  command = plan

  variables {
    seed_user_id = "acme-admin"
  }

  expect_failures = [var.seed_user_id]
}

run "a_seed_id_in_upper_case_is_taken" {
  command = plan

  variables {
    seed_tenant_id = "0000000A-0000-4000-8000-0000000000AB"
    seed_user_id   = "0000000A-0000-4000-8000-0000000000CD"
  }
}

run "latest_is_refused" {
  command = plan

  variables {
    secrets_aad_key_version = "latest"
  }

  expect_failures = [var.secrets_aad_key_version]
}

run "an_existing_repository_in_the_same_project" {
  command = plan

  variables {
    image_repository = { project = "acme-app-dev", location = "us", repository = "acme-images" }
  }

  assert {
    condition     = length(google_artifact_registry_repository.images) == 0
    error_message = "With image_repository, the module creates no repository."
  }
  assert {
    condition     = google_artifact_registry_repository_iam_member.server_reads_images.repository == "acme-images" && google_artifact_registry_repository_iam_member.server_reads_images.location == "us"
    error_message = "The server reads the named repository."
  }
  assert {
    condition     = length(google_artifact_registry_repository_iam_member.run_agent_pulls_images) == 0
    error_message = "A repository in the same project needs no pull grant for the Cloud Run service agent."
  }
  assert {
    condition     = output.image_repository == "us-docker.pkg.dev/acme-app-dev/acme-images"
    error_message = "image_repository points at the named repository."
  }
}

run "an_existing_repository_in_another_project" {
  command = plan

  variables {
    image_repository = { project = "acme-shared-images", location = "us", repository = "acme-images" }
  }

  assert {
    condition     = length(google_artifact_registry_repository_iam_member.run_agent_pulls_images) == 1
    error_message = "A repository in another project gets a pull grant for this project's Cloud Run service agent."
  }
  assert {
    condition     = google_artifact_registry_repository_iam_member.run_agent_pulls_images[0].member == "serviceAccount:service-123456789012@serverless-robot-prod.iam.gserviceaccount.com"
    error_message = "The pull grant names this project's Cloud Run service agent."
  }
}

run "the_pack_invokes_the_named_services" {
  # Applied against the mock, so the pack's service account email is
  # known. The test's teardown passes over the key's prevent_destroy.
  command = apply

  variables {
    pack_run_invokers = [
      { project = "acme-app-dev", location = "northamerica-northeast2", service = "acme-search" },
      { project = "acme-shared", location = "us-central1", service = "acme-ocr" },
    ]
  }

  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.pack_invokes) == 2
    error_message = "One invoker grant per named service."
  }
  assert {
    condition = alltrue([
      for g in google_cloud_run_v2_service_iam_member.pack_invokes :
      g.role == "roles/run.invoker" && g.member == "serviceAccount:${google_service_account.pack.email}"
    ])
    error_message = "Each grant gives the pack's service account roles/run.invoker."
  }
  assert {
    condition = (
      google_cloud_run_v2_service_iam_member.pack_invokes["acme-shared/us-central1/acme-ocr"].project == "acme-shared" &&
      google_cloud_run_v2_service_iam_member.pack_invokes["acme-shared/us-central1/acme-ocr"].location == "us-central1" &&
      google_cloud_run_v2_service_iam_member.pack_invokes["acme-shared/us-central1/acme-ocr"].name == "acme-ocr"
    )
    error_message = "A service in another project is granted in that project and region."
  }
}

run "a_service_url_is_refused" {
  command = plan

  variables {
    pack_run_invokers = [
      { project = "acme-app-dev", location = "northamerica-northeast2", service = "https://acme-search-abc123-pd.a.run.app" },
    ]
  }

  expect_failures = [var.pack_run_invokers]
}

run "a_service_named_twice_is_refused" {
  command = plan

  variables {
    pack_run_invokers = [
      { project = "acme-app-dev", location = "northamerica-northeast2", service = "acme-search" },
      { project = "acme-app-dev", location = "northamerica-northeast2", service = "acme-search" },
    ]
  }

  expect_failures = [var.pack_run_invokers]
}

# Cloud Run's front end appends the client to X-Forwarded-For, and the
# container's peer is its own proxy (measured live, 2026-10-08): one trusted
# hop by default, so rate limits and audit records see the client.
run "trusts_one_proxy_by_default" {
  command = plan
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_TRUSTED_PROXIES"
    ]) == "1"
    error_message = "The server trusts one hop: Cloud Run's front end."
  }
}

run "trusted_proxies_takes_ranges" {
  command = plan
  variables {
    trusted_proxies = "10.0.0.0/8, 2001:db8::/32"
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_TRUSTED_PROXIES"
    ]) == "10.0.0.0/8, 2001:db8::/32"
    error_message = "IP/CIDR ranges pass through as given."
  }
}

run "empty_trusted_proxies_leaves_it_unset" {
  command = plan
  variables {
    trusted_proxies = ""
  }
  assert {
    condition = length([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name
      if e.name == "KINDGI_TRUSTED_PROXIES"
    ]) == 0
    error_message = "An empty trusted_proxies sets no KINDGI_TRUSTED_PROXIES."
  }
}

run "trusted_proxies_refuses_a_word" {
  command = plan
  variables {
    trusted_proxies = "all"
  }
  expect_failures = [var.trusted_proxies]
}

# Sign-in on the server: off unless the operator turns it on (runtime 0.1.5
# defaults console token sign-in off outside `kindgi dev`).
run "sign_in_is_off_by_default" {
  command = plan
  assert {
    condition = length([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name
      if contains(["KINDGI_PUBLIC_URL", "KINDGI_CONSOLE_TOKEN_SIGN_IN", "KINDGI_AUTH_SECRET"], e.name)
    ]) == 0
    error_message = "By default the module sets no public URL and turns no sign-in on."
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.server_reads_its_secrets) == 0
    error_message = "Without server_secret_env, the server gets no grant on the operator's secrets."
  }
}

run "sign_in_settings_reach_the_server" {
  command = plan
  variables {
    public_url = "https://kindgi.acme.example"
    server_env = {
      KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
      KINDGI_AUTH_EMAIL_FROM       = "Kindgi <kindgi@acme.example>"
    }
    server_secret_env = {
      KINDGI_AUTH_SECRET         = { secret = "kindgi-dev-auth-secret", version = "1" }
      KINDGI_AUTH_EMAIL_SMTP_URL = { secret = "acme-smtp-url", version = "latest", project = "acme-shared" }
    }
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_PUBLIC_URL"
    ]) == "https://kindgi.acme.example"
    error_message = "public_url becomes KINDGI_PUBLIC_URL."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_CONSOLE_TOKEN_SIGN_IN"
    ]) == "on"
    error_message = "A server_env value reaches the server as given."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}"
      if e.name == "KINDGI_AUTH_SECRET"
    ]) == "kindgi-dev-auth-secret@1"
    error_message = "A server_secret_env entry is a Secret Manager reference at its version."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].secret
      if e.name == "KINDGI_AUTH_EMAIL_SMTP_URL"
    ]) == "projects/acme-shared/secrets/acme-smtp-url"
    error_message = "A secret in another project is referenced by its full name."
  }
  assert {
    condition     = keys(google_secret_manager_secret_iam_member.server_reads_its_secrets) == ["KINDGI_AUTH_SECRET"]
    error_message = "The server is granted the same-project secret only; another project's is granted there."
  }
}

run "a_name_the_module_sets_is_refused" {
  command = plan
  variables {
    server_env = { KINDGI_TRUSTED_PROXIES = "2" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "kindgi_dev_is_refused" {
  command = plan
  variables {
    server_env = { KINDGI_DEV = "1" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "the_public_url_goes_in_its_variable" {
  command = plan
  variables {
    server_env = { KINDGI_PUBLIC_URL = "https://kindgi.acme.example" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "a_name_in_both_maps_is_refused" {
  command = plan
  variables {
    server_env        = { KINDGI_AUTH_EMAIL_FROM = "Kindgi <kindgi@acme.example>" }
    server_secret_env = { KINDGI_AUTH_EMAIL_FROM = { secret = "acme-from", version = "1" } }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "a_secret_as_a_plain_value_is_refused" {
  command = plan
  variables {
    server_env = { KINDGI_AUTH_SECRET = "c2VjcmV0" }
  }
  expect_failures = [var.server_env]
}

run "a_preshared_key_as_a_plain_value_is_refused" {
  command = plan
  variables {
    server_env = { KINDGI_OPENFGA_PRESHARED_KEY = "not-in-the-plan" }
  }
  expect_failures = [var.server_env]
}

run "identity_provider_sign_in_needs_public_url" {
  command = plan
  variables {
    server_secret_env = { KINDGI_AUTH_SECRET = { secret = "kindgi-dev-auth-secret", version = "1" } }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "public_url_refuses_a_path" {
  command = plan
  variables {
    public_url = "https://kindgi.acme.example/console"
  }
  expect_failures = [var.public_url]
}

# The names server_env can't set are every name the module sets: with each
# option on, nothing the server gets is missing from the list.
run "the_refused_names_cover_every_option_secret_signing" {
  command = plan
  variables {
    export_signing       = "secret"
    cors_origins         = ["https://app.acme.example"]
    openfga_api_url      = "http://openfga.acme.internal:8080"
    pack_call_timeout_ms = 300000
    public_url           = "https://kindgi.acme.example"
  }
  assert {
    condition = alltrue([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : contains(local.server_module_env, e.name)
    ])
    error_message = "A name the module sets on the server is missing from server_module_env."
  }
}

run "the_refused_names_cover_every_option_kms_signing" {
  command = plan
  variables {
    export_signing         = "kms"
    export_signing_kms_key = "projects/acme-app-dev/locations/northamerica-northeast2/keyRings/kindgi/cryptoKeys/exports/cryptoKeyVersions/1"
  }
  assert {
    condition = alltrue([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : contains(local.server_module_env, e.name)
    ])
    error_message = "A name the module sets on the server is missing from server_module_env."
  }
}

run "backups_keep_cloud_sqls_defaults" {
  command = plan

  assert {
    condition     = length(google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].backup_retention_settings) == 0
    error_message = "Without database_backup_retention, the module sets no retention: Cloud SQL's default (7) stays."
  }
  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].location == null
    error_message = "Without database_backup_location, the module sets no location: Cloud SQL's choice stays."
  }
}

run "backups_kept_where_and_as_long_as_asked" {
  command = plan

  variables {
    database_backup_retention   = 30
    database_backup_location    = "us"
    database_point_in_time_days = 7
  }

  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].backup_retention_settings[0].retained_backups == 30
    error_message = "database_backup_retention reaches the instance's retained backups."
  }
  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].backup_retention_settings[0].retention_unit == "COUNT"
    error_message = "Retention counts backups."
  }
  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].location == "us"
    error_message = "database_backup_location reaches the backups' location."
  }
  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].transaction_log_retention_days == 7
    error_message = "database_point_in_time_days reaches the transaction logs' retention."
  }
  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].enabled && google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].point_in_time_recovery_enabled
    error_message = "Backups and point-in-time recovery stay on."
  }
}

run "backup_retention_refuses_none_or_a_fraction" {
  command = plan

  variables {
    database_backup_retention = 0
  }

  expect_failures = [var.database_backup_retention]
}

run "backup_location_takes_a_region" {
  command = plan

  variables {
    database_backup_location = "northamerica-northeast2"
  }

  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].location == "northamerica-northeast2"
    error_message = "A region reaches the backups' location."
  }
}

run "backup_location_refuses_a_zone" {
  command = plan

  variables {
    database_backup_location = "us-central1-a"
  }

  expect_failures = [var.database_backup_location]
}

run "backup_location_refuses_another_multi_region_name" {
  command = plan

  variables {
    database_backup_location = "europe"
  }

  expect_failures = [var.database_backup_location]
}

run "backup_location_refuses_a_bucket_like_name" {
  command = plan

  variables {
    database_backup_location = "gs://acme-backups"
  }

  expect_failures = [var.database_backup_location]
}

run "point_in_time_days_refuses_more_than_35" {
  command = plan

  variables {
    database_point_in_time_days = 36
  }

  expect_failures = [var.database_point_in_time_days]
}

run "point_in_time_days_over_7_need_enterprise_plus" {
  command = plan

  variables {
    database_point_in_time_days = 14
  }

  expect_failures = [google_sql_database_instance.kindgi]
}

run "fewer_backups_than_the_default_log_days_are_refused" {
  # ENTERPRISE keeps 7 days of logs unless told otherwise.
  command = plan

  variables {
    database_backup_retention = 3
  }

  expect_failures = [google_sql_database_instance.kindgi]
}

run "more_log_days_than_backups_are_refused" {
  command = plan

  variables {
    database_backup_retention   = 4
    database_point_in_time_days = 5
  }

  expect_failures = [google_sql_database_instance.kindgi]
}

run "more_log_days_than_the_default_backups_are_refused" {
  # ENTERPRISE_PLUS keeps 15 backups unless told otherwise.
  command = plan

  variables {
    database_edition            = "ENTERPRISE_PLUS"
    database_tier               = "db-perf-optimized-N-2"
    database_point_in_time_days = 20
  }

  expect_failures = [google_sql_database_instance.kindgi]
}

run "as_many_log_days_as_backups_plan" {
  command = plan

  variables {
    database_backup_retention   = 5
    database_point_in_time_days = 5
  }

  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].transaction_log_retention_days == 5
    error_message = "As many days of logs as backups kept is Cloud SQL's limit, and plans."
  }
}

run "point_in_time_days_up_to_35_on_enterprise_plus" {
  command = plan

  variables {
    database_edition            = "ENTERPRISE_PLUS"
    database_tier               = "db-perf-optimized-N-2"
    database_point_in_time_days = 14
  }

  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].backup_configuration[0].transaction_log_retention_days == 14
    error_message = "ENTERPRISE_PLUS keeps more than 7 days of transaction logs."
  }
}

# ---- tenancy ------------------------------------------------------------------

# "single", the default: the tenant and the seed user, as before tenancy
# existed.
run "single_sets_the_tenant_and_seed_user_and_no_tenancy" {
  command = plan
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_TENANT_ID"
    ]) == "00000000-0000-0000-0000-000000000001"
    error_message = "With tenancy = \"single\", the server gets KINDGI_TENANT_ID = seed_tenant_id."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_SEED_USER_ID"
    ]) == "00000000-0000-0000-0000-000000000002"
    error_message = "With tenancy = \"single\", the server gets KINDGI_SEED_USER_ID = seed_user_id."
  }
  assert {
    condition = length([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name
      if e.name == "KINDGI_TENANCY"
    ]) == 0
    error_message = "With tenancy = \"single\", KINDGI_TENANCY isn't set: an earlier runtime gets the env it always had."
  }
}

run "single_needs_the_seed_tenant" {
  command = plan
  variables {
    seed_tenant_id = null
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "single_needs_the_seed_user" {
  command = plan
  variables {
    seed_user_id = null
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "tenancy_refuses_a_word" {
  command = plan
  variables {
    tenancy = "many"
  }
  expect_failures = [var.tenancy]
}

run "kindgi_tenancy_goes_in_its_variable" {
  command = plan
  variables {
    server_env = { KINDGI_TENANCY = "multi" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

# "multi": every setting it needs, and then each one taken away.
run "multi_sets_tenancy_and_neither_id" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS = "isolated"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_TENANCY"
    ]) == "multi"
    error_message = "With tenancy = \"multi\", the server gets KINDGI_TENANCY = multi."
  }
  assert {
    condition = length(setintersection(toset([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name
    ]), toset(["KINDGI_TENANT_ID", "KINDGI_SEED_USER_ID"]))) == 0
    error_message = "With tenancy = \"multi\", the server gets neither KINDGI_TENANT_ID nor KINDGI_SEED_USER_ID: the runtime refuses both."
  }
  assert {
    condition = alltrue([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : contains(local.server_module_env, e.name)
      if !contains(keys(var.server_env), e.name) && !contains(keys(var.server_secret_env), e.name)
    ])
    error_message = "A name the module sets on the server is missing from server_module_env."
  }
}

run "multi_takes_the_none_secrets_backend" {
  command = plan
  variables {
    tenancy                 = "multi"
    seed_tenant_id          = null
    seed_user_id            = null
    openfga_api_url         = "https://openfga-acme.a.run.app"
    secrets_backend         = "none"
    secrets_aad_key_version = null
    server_env = {
      KINDGI_TENANT_HOST_ACCESS = "isolated"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name], "KINDGI_PACK_ENDPOINT_KMS_KEY")
    error_message = "Without the postgres secrets backend, the server still seals endpoint tokens under the module's key."
  }
}

run "multi_refuses_a_seed_tenant" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = "00000000-0000-0000-0000-000000000001"
    seed_user_id    = null
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS = "isolated"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_refuses_a_seed_user" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = "00000000-0000-0000-0000-000000000002"
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS = "isolated"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_needs_openfga" {
  command = plan
  variables {
    tenancy        = "multi"
    seed_tenant_id = null
    seed_user_id   = null
    server_env = {
      KINDGI_TENANT_HOST_ACCESS = "isolated"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_needs_the_openfga_key" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS = "isolated"
    }
    server_secret_env = {}
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_needs_isolated_host_access" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

# ---- the pack services: one per deployment --------------------------------------

# Any tenancy: the server calls each deployment's own pack service, which
# the orchestrator makes in this project and region.
run "the_server_routes_per_deployment" {
  command = plan
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_PACK_ROUTING"
    ]) == "per-deployment"
    error_message = "The server routes each deployment to its own pack service."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_PACK_ENDPOINT_HOSTS"
    ]) == "*-123456789012.northamerica-northeast2.run.app"
    error_message = "The server takes an endpoint only on Cloud Run's URLs in this project (by number) and region."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_ENV_CLOUD_SECRETS"
    ]) == "on"
    error_message = "The server takes cloud secrets in a pack's env, which each deployment's own service reads."
  }
  assert {
    condition     = length(setintersection(toset([for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name]), local.single_pack_env)) == 0
    error_message = "The server gets none of the one pack service's settings."
  }
  assert {
    condition     = google_project_iam_member.server_invokes_packs.role == "roles/run.invoker" && google_project_iam_member.server_invokes_packs.project == "acme-app-dev"
    error_message = "The server may invoke the project's services, so every pack service the orchestrator makes."
  }
  assert {
    condition     = google_cloud_run_v2_service.server.template[0].containers[0].resources[0].cpu_idle == false
    error_message = "The server keeps its CPU between requests: a run started with wait:false keeps executing after its 202."
  }
}

run "the_pack_routing_is_the_modules" {
  command = plan
  variables {
    server_env = { KINDGI_PACK_ROUTING = "single" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "the_cloud_secrets_switch_is_the_modules" {
  command = plan
  variables {
    server_env = { KINDGI_ENV_CLOUD_SECRETS = "on" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "the_endpoint_hosts_are_the_modules" {
  command = plan
  variables {
    server_env = { KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "the_one_pack_services_url_is_refused" {
  command = plan
  variables {
    server_env = { KINDGI_PACK_SERVICE_URL = "https://kindgi-dev-pack-123456789012.northamerica-northeast2.run.app" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "the_one_pack_services_token_is_refused" {
  command = plan
  variables {
    server_secret_env = {
      KINDGI_PACK_SERVICE_TOKEN = { secret = "kindgi-dev-pack-service-token", version = "1" }
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

# ---- the pack orchestrator --------------------------------------------------------

# Its account, grants and key's secret come with the first apply; the Job
# and its schedule only once its key is a version (orchestrator_key_version).
run "the_orchestrator_waits_for_its_key" {
  command = plan
  assert {
    condition     = length(google_cloud_run_v2_job.orchestrator) == 0 && length(google_cloud_scheduler_job.orchestrator) == 0
    error_message = "Without orchestrator_key_version, no Job and no schedule: its key can be minted only once the server routes per deployment."
  }
  assert {
    condition     = google_secret_manager_secret.orchestrator_key.secret_id == "kindgi-dev-orchestrator-key"
    error_message = "The key's secret exists from the first apply, for the version the operator adds."
  }
  assert {
    condition     = google_service_account.orchestrator.account_id == "kindgi-dev-orch"
    error_message = "The orchestrator has an account of its own."
  }
  assert {
    condition     = contains(keys(google_project_service.apis), "cloudscheduler.googleapis.com")
    error_message = "Cloud Scheduler is on from the first apply."
  }
}

run "the_orchestrator_runs_once_a_minute_with_its_key" {
  command = plan
  variables {
    orchestrator_key_version = "3"
  }
  assert {
    condition     = google_cloud_run_v2_job.orchestrator[0].name == "kindgi-dev-pack-orchestrator" && google_cloud_run_v2_job.orchestrator[0].location == "northamerica-northeast2"
    error_message = "The Job is <name_prefix>-pack-orchestrator, in the region."
  }
  assert {
    condition = (
      google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].image == var.server_image &&
      google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].args == tolist(["packs", "orchestrate"])
    )
    error_message = "The Job runs `kindgi-runtime packs orchestrate` from the server's image."
  }
  assert {
    condition = (
      google_cloud_run_v2_job.orchestrator[0].template[0].task_count == 1 &&
      google_cloud_run_v2_job.orchestrator[0].template[0].template[0].max_retries == 0 &&
      google_cloud_run_v2_job.orchestrator[0].template[0].template[0].timeout == "600s"
    )
    error_message = "One task, no retries (next minute's run is the retry), and a backstop timeout."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env :
      "${e.value_source[0].secret_key_ref[0].secret}@${e.value_source[0].secret_key_ref[0].version}" if e.name == "KINDGI_ORCHESTRATOR_SYSTEM_KEY"
    ]) == "kindgi-dev-orchestrator-key@3"
    error_message = "The Job reads its key at the version orchestrator_key_version pins."
  }
  assert {
    condition = (
      one([for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.value if e.name == "KINDGI_ORCHESTRATOR_PROJECT"]) == "acme-app-dev" &&
      one([for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.value if e.name == "KINDGI_ORCHESTRATOR_REGION"]) == "northamerica-northeast2"
    )
    error_message = "The Job makes pack services in this project and region."
  }
  assert {
    condition = jsondecode(one([
      for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.value
      if e.name == "KINDGI_ORCHESTRATOR_PACK_SERVICE"
    ])) == { ingress = "internal", egress = { kind = "none" }, timeoutSeconds = 300, concurrency = 32, maxInstances = 8 }
    error_message = "By default each pack service is internal, has no connector, and takes pack_timeout, pack_concurrency and pack_max_instances."
  }
  assert {
    condition     = !contains([for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.name], "KINDGI_ORCHESTRATOR_RUNTIME_AUTH")
    error_message = "A public server (server_public, the default) takes the Job's calls on the system key alone."
  }
  assert {
    condition = (
      google_cloud_scheduler_job.orchestrator[0].schedule == "* * * * *" &&
      google_cloud_scheduler_job.orchestrator[0].retry_config[0].retry_count == 0 &&
      google_cloud_scheduler_job.orchestrator[0].http_target[0].http_method == "POST" &&
      google_cloud_scheduler_job.orchestrator[0].http_target[0].uri == "https://run.googleapis.com/v2/projects/acme-app-dev/locations/northamerica-northeast2/jobs/kindgi-dev-pack-orchestrator:run"
    )
    error_message = "Cloud Scheduler runs the Job once a minute, one attempt each."
  }
  assert {
    condition     = google_cloud_scheduler_job.orchestrator[0].http_target[0].oauth_token[0].scope == "https://www.googleapis.com/auth/cloud-platform"
    error_message = "Cloud Scheduler runs the Job with an OAuth token."
  }
  assert {
    condition     = output.orchestrator_key_steps == null
    error_message = "With the key set, there are no steps left to show."
  }
}

run "the_orchestrator_names_the_connector_and_the_cloud_sql_instances" {
  command = plan
  variables {
    orchestrator_key_version = "1"
    network_mode             = "connector"
    vpc_connector            = "projects/acme-app-dev/locations/northamerica-northeast2/connectors/acme"
    pack_ingress             = "INGRESS_TRAFFIC_ALL"
    pack_timeout             = "900s"
    pack_cloud_sql_instances = ["acme-app-dev:northamerica-northeast2:acme-app-db"]
  }
  assert {
    condition = jsondecode(one([
      for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.value
      if e.name == "KINDGI_ORCHESTRATOR_PACK_SERVICE"
      ])) == {
      ingress           = "all"
      egress            = { kind = "connector", connector = "projects/acme-app-dev/locations/northamerica-northeast2/connectors/acme" }
      timeoutSeconds    = 900
      concurrency       = 32
      maxInstances      = 8
      cloudSqlInstances = ["acme-app-dev:northamerica-northeast2:acme-app-db"]
    }
    error_message = "In connector mode each pack service is public behind IAM, egresses through the connector, and mounts the named Cloud SQL instances."
  }
}

run "a_server_behind_iam_takes_the_jobs_id_token" {
  command = plan
  variables {
    orchestrator_key_version = "1"
    server_public            = false
  }
  assert {
    condition     = google_cloud_run_v2_service_iam_member.orchestrator_invokes_server[0].role == "roles/run.invoker" && google_cloud_run_v2_service_iam_member.orchestrator_invokes_server[0].name == "kindgi-dev-server"
    error_message = "Behind Cloud Run IAM, the orchestrator may invoke the server."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.value
      if e.name == "KINDGI_ORCHESTRATOR_RUNTIME_AUTH"
    ]) == "google-id-token"
    error_message = "Behind Cloud Run IAM, the Job sends a Google ID token beside its system key."
  }
}

run "a_public_server_grants_the_orchestrator_nothing_on_it" {
  command = plan
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.orchestrator_invokes_server) == 0
    error_message = "A public server needs no invoker grant for the orchestrator."
  }
}

run "the_orchestrator_has_only_its_own_rights" {
  command = plan
  assert {
    condition = (
      google_project_iam_member.orchestrator_runs_services.role == "roles/run.developer" &&
      google_service_account_iam_member.orchestrator_acts_as_pack.role == "roles/iam.serviceAccountUser"
    )
    error_message = "The orchestrator manages the project's services, and runs them as the pack account."
  }
  assert {
    condition = toset(google_project_iam_custom_role.pack_secrets.permissions) == toset([
      "secretmanager.secrets.create", "secretmanager.secrets.delete", "secretmanager.secrets.get",
      "secretmanager.versions.add", "secretmanager.versions.destroy", "secretmanager.versions.list",
    ]) && google_project_iam_custom_role.pack_secrets.role_id == "kindgi_dev_pack_secrets"
    error_message = "On the pack services' own secrets the orchestrator makes, adds to, destroys and deletes, and never reads a value."
  }
  assert {
    condition     = google_project_iam_member.orchestrator_pack_secrets.condition[0].expression == "resource.name.startsWith(\"projects/123456789012/secrets/kp-\")"
    error_message = "Those rights hold on kp- secrets only, named as Secret Manager names them, by project number."
  }
  assert {
    condition     = google_project_iam_custom_role.secret_list.permissions == toset(["secretmanager.secrets.list"]) && length(google_project_iam_member.orchestrator_lists_secrets.condition) == 0
    error_message = "Listing is asked of the project, so it's a role of its own with no condition, and lists names only."
  }
  assert {
    condition     = google_secret_manager_secret_iam_member.orchestrator_reads_key.role == "roles/secretmanager.secretAccessor"
    error_message = "The orchestrator reads its own key."
  }
}

run "the_pack_account_reads_its_own_secrets_and_the_listed_cloud_secrets" {
  command = plan
  variables {
    pack_secret_readers = [
      { secret = "acme-api-key" },
      { secret = "acme-ocr-key", project = "acme-shared" },
    ]
  }
  assert {
    condition     = google_project_iam_member.pack_reads_pack_secrets.role == "roles/secretmanager.secretAccessor" && google_project_iam_member.pack_reads_pack_secrets.condition[0].expression == "resource.name.startsWith(\"projects/123456789012/secrets/kp-\")"
    error_message = "The pack account reads the kp- secrets, its token and env values among them."
  }
  assert {
    condition = toset([for g in google_secret_manager_secret_iam_member.pack_reads_cloud_secrets : g.secret_id]) == toset([
      "projects/acme-app-dev/secrets/acme-api-key",
      "projects/acme-shared/secrets/acme-ocr-key",
    ])
    error_message = "Each listed secret is granted where it is: this project when project is null."
  }
  assert {
    condition     = alltrue([for g in google_secret_manager_secret_iam_member.pack_reads_cloud_secrets : g.role == "roles/secretmanager.secretAccessor"])
    error_message = "The pack account reads each listed secret."
  }
}

run "pack_secret_readers_refuses_a_kp_secret" {
  command = plan
  variables {
    pack_secret_readers = [{ secret = "kp-acme-token" }]
  }
  expect_failures = [var.pack_secret_readers]
}

run "pack_secret_readers_refuses_a_path" {
  command = plan
  variables {
    pack_secret_readers = [{ secret = "projects/acme-app-dev/secrets/acme-api-key" }]
  }
  expect_failures = [var.pack_secret_readers]
}

run "pack_secret_readers_refuses_a_secret_twice" {
  command = plan
  variables {
    pack_secret_readers = [{ secret = "acme-api-key" }, { secret = "acme-api-key", project = null }]
  }
  expect_failures = [var.pack_secret_readers]
}

run "name_prefix_refuses_kp" {
  command = plan
  variables {
    name_prefix = "kp"
  }
  expect_failures = [var.name_prefix]
}

run "name_prefix_refuses_a_kp_prefix" {
  command = plan
  variables {
    name_prefix = "kp-acme"
  }
  expect_failures = [var.name_prefix]
}

run "orchestrator_key_version_refuses_latest" {
  command = plan
  variables {
    orchestrator_key_version = "latest"
  }
  expect_failures = [var.orchestrator_key_version]
}

run "pack_timeout_refuses_more_than_an_hour" {
  command = plan
  variables {
    pack_timeout = "3601s"
  }
  expect_failures = [var.pack_timeout]
}

run "pack_timeout_refuses_minutes" {
  command = plan
  variables {
    pack_timeout = "5m"
  }
  expect_failures = [var.pack_timeout]
}

run "pack_concurrency_refuses_a_fraction" {
  command = plan
  variables {
    pack_concurrency = 1.5
  }
  expect_failures = [var.pack_concurrency]
}

run "pack_max_instances_refuses_none" {
  command = plan
  variables {
    pack_max_instances = 0
  }
  expect_failures = [var.pack_max_instances]
}

run "pack_cloud_sql_instances_refuses_more_than_ten" {
  command = plan
  variables {
    pack_cloud_sql_instances = [for i in range(11) : "acme-app-dev:northamerica-northeast2:acme-db-${i}"]
  }
  expect_failures = [var.pack_cloud_sql_instances]
}

# Applied against the mock, so the server's URL is known in the steps.
run "the_key_steps_mint_the_orchestrators_key_on_the_server" {
  command = apply
  assert {
    condition = (
      strcontains(output.orchestrator_key_steps, "${google_cloud_run_v2_service.server.uri}/v1/system/keys") &&
      strcontains(output.orchestrator_key_steps, "\"scopes\": [\"system:deployments\", \"system:pack-env\"]") &&
      strcontains(output.orchestrator_key_steps, "gcloud secrets versions add kindgi-dev-orchestrator-key --data-file=-") &&
      strcontains(output.orchestrator_key_steps, "orchestrator_key_version")
    )
    error_message = "Until its key is set, the steps mint it on the server, add it as a version and name the variable to set."
  }
  assert {
    condition     = toset(keys(output.service_accounts)) == toset(["server", "pack", "orchestrator"]) && output.service_accounts.orchestrator == google_service_account.orchestrator.email
    error_message = "service_accounts names the server's, the pack services' and the orchestrator's accounts."
  }
}

run "behind_iam_the_key_steps_carry_an_identity_token" {
  command = apply
  variables {
    server_public = false
  }
  assert {
    condition     = strcontains(output.orchestrator_key_steps, "-H @<(printf 'X-Serverless-Authorization: Bearer %s\\n' \"$(gcloud auth print-identity-token)\") \\")
    error_message = "Behind Cloud Run IAM, the minting call sends the operator's ID token, from a process substitution, not on the command line."
  }
}

run "a_public_server_s_key_steps_send_no_identity_token" {
  command = apply
  assert {
    condition     = !strcontains(output.orchestrator_key_steps, "X-Serverless-Authorization")
    error_message = "A public server's minting call needs the bearer token alone."
  }
}

# ---- database_instance: serving from another instance ------------------------

run "unset_the_server_serves_from_its_own_instance" {
  command = plan

  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].secret
      if e.name == "KINDGI_DATABASE_URL"
    ]) == "kindgi-dev-database-url"
    error_message = "Without database_instance, KINDGI_DATABASE_URL reads the module's own secret."
  }
  assert {
    condition     = length(data.google_sql_database_instance.served) == 0 && length(google_project_iam_member.server_sql_client_served) == 0
    error_message = "Without database_instance, no other instance is read or granted."
  }
  assert {
    condition     = length(google_cloud_run_v2_service.server.template[0].volumes[0].cloud_sql_instance[0].instances) == 1
    error_message = "The /cloudsql volume names one instance: the module's own."
  }
}

run "the_cloudsql_socket_has_no_server_ca" {
  command = plan

  assert {
    condition     = length(data.google_sql_ca_certs.kindgi) == 0
    error_message = "Through /cloudsql, the instance's CAs aren't read: the connector checks the instance."
  }
  assert {
    condition = length([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e
      if startswith(e.name, "KINDGI_DATABASE_SERVER_CA")
    ]) == 0
    error_message = "Through /cloudsql, the server gets no database CA, which the runtime refuses with a socket."
  }
}

run "private_ip_mode_checks_the_database_against_every_instance_ca" {
  # Apply (mocked): the CAs are read once the instance exists.
  command = apply
  variables {
    database_private_network = "projects/acme-app-dev/global/networks/acme"
  }

  assert {
    condition = [
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value
      if e.name == "KINDGI_DATABASE_SERVER_CA"
      ] == [
      "-----BEGIN CERTIFICATE-----\nacme in use\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nacme upcoming\n-----END CERTIFICATE-----"
    ]
    error_message = "Private-IP mode sets KINDGI_DATABASE_SERVER_CA to every CA the instance lists, the upcoming one too."
  }
  assert {
    condition     = length(google_cloud_run_v2_service.server.template[0].volumes) == 0
    error_message = "Private-IP mode has no /cloudsql volume."
  }
}

run "private_ip_mode_refuses_an_instance_without_a_ca" {
  # The run above's settings, so the plan changes nothing it reads and the
  # CAs are read at plan time (with a change pending, the read waits).
  command = plan
  variables {
    database_private_network = "projects/acme-app-dev/global/networks/acme"
    secrets_backend          = "none"
    secrets_aad_key_version  = null
  }
  override_data {
    target = data.google_sql_ca_certs.kindgi
    values = {
      certs = []
    }
  }
  expect_failures = [data.google_sql_ca_certs.kindgi]
}

run "the_database_ca_settings_are_the_modules" {
  command = plan
  variables {
    server_env = { KINDGI_DATABASE_SERVER_CA_PATH = "/etc/kindgi/db-ca.pem" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "the_inline_database_ca_is_the_modules" {
  command = plan
  variables {
    server_env = { KINDGI_DATABASE_SERVER_CA = "-----BEGIN CERTIFICATE-----" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

# The grant's condition keeps the title and description earlier releases
# applied: the Google provider replaces the grant when either changes.
run "the_sql_grant_keeps_its_condition_text" {
  command = plan

  assert {
    condition     = google_project_iam_member.server_sql_client[0].condition[0].title == "kindgi-instance-only"
    error_message = "The server's Cloud SQL grant keeps its condition's title, kindgi-instance-only."
  }
  assert {
    condition     = google_project_iam_member.server_sql_client[0].condition[0].description == "Kindgi's own Cloud SQL instance only."
    error_message = "The server's Cloud SQL grant keeps its condition's description, \"Kindgi's own Cloud SQL instance only.\""
  }
}

run "database_instance_moves_the_server_and_keeps_its_own_instance" {
  command = plan

  variables {
    database_instance = {
      name       = "kindgi-dev-restored"
      url_secret = "kindgi-dev-restored-database-url"
    }
  }

  assert {
    condition     = google_cloud_run_v2_service.server.template[0].volumes[0].cloud_sql_instance[0].instances == toset(["acme-app-dev:northamerica-northeast2:kindgi-dev-restored"])
    error_message = "The /cloudsql volume names database_instance's instance alone."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].secret
      if e.name == "KINDGI_DATABASE_URL"
    ]) == "kindgi-dev-restored-database-url"
    error_message = "KINDGI_DATABASE_URL reads database_instance.url_secret."
  }
  assert {
    condition     = google_project_iam_member.server_sql_client_served[0].condition[0].expression == "resource.name == \"projects/acme-app-dev/instances/kindgi-dev-restored\""
    error_message = "The server's account may connect to database_instance's instance, and only to it."
  }
  assert {
    condition     = google_project_iam_member.server_sql_client_served[0].condition[0].title != google_project_iam_member.server_sql_client[0].condition[0].title
    error_message = "The served instance's grant has a condition of its own, so it's a binding of its own."
  }
  assert {
    condition     = google_project_iam_member.server_sql_client[0].condition[0].expression == "resource.name == \"projects/acme-app-dev/instances/kindgi-dev\""
    error_message = "The grant on the module's own instance stays, for the revision that still serves from it."
  }
  assert {
    condition     = google_sql_database_instance.kindgi[0].name == "kindgi-dev" && contains(keys(google_secret_manager_secret.server), "database_url")
    error_message = "The module's own instance and its URL secret stay."
  }
  assert {
    condition = length([
      for m in google_secret_manager_secret_iam_member.server_reads_its_secrets : m
      if endswith(m.secret_id, "/kindgi-dev-restored-database-url")
    ]) == 0
    error_message = "The module doesn't grant reading url_secret: whoever made it does."
  }
}

run "database_instance_refuses_private_ip_mode" {
  command = plan
  variables {
    database_private_network = "projects/acme-app-dev/global/networks/acme"
    database_instance = {
      name       = "kindgi-dev-restored"
      url_secret = "kindgi-dev-restored-database-url"
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "database_instance_refuses_the_own_instance" {
  command = plan
  variables {
    database_instance = {
      name       = "kindgi-dev"
      url_secret = "kindgi-dev-restored-database-url"
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "database_instance_refuses_the_own_url_secret" {
  command = plan
  variables {
    database_instance = {
      name       = "kindgi-dev-restored"
      url_secret = "kindgi-dev-database-url"
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "database_instance_refuses_an_instance_without_a_public_ip" {
  command = plan
  variables {
    database_instance = {
      name       = "kindgi-dev-restored"
      url_secret = "kindgi-dev-restored-database-url"
    }
  }
  override_data {
    target = data.google_sql_database_instance.served
    values = {
      settings = [{
        ip_configuration = [{ ipv4_enabled = false }]
      }]
    }
  }
  expect_failures = [data.google_sql_database_instance.served]
}

run "database_instance_refuses_a_connection_name" {
  command = plan
  variables {
    database_instance = {
      name       = "acme-app-dev:northamerica-northeast2:kindgi-dev-restored"
      url_secret = "kindgi-dev-restored-database-url"
    }
  }
  expect_failures = [var.database_instance]
}

run "database_instance_refuses_a_secret_path" {
  command = plan
  variables {
    database_instance = {
      name       = "kindgi-dev-restored"
      url_secret = "projects/acme-app-dev/secrets/kindgi-dev-restored-database-url"
    }
  }
  expect_failures = [var.database_instance]
}

# ---- database_host_instance: Kindgi's database on the app's instance ---------

run "host_puts_kindgis_database_on_the_app_instance" {
  command = plan
  variables {
    database_host_instance = "acme-app-db"
  }
  override_data {
    target = data.google_sql_database_instance.host
    values = {
      connection_name  = "acme-app-dev:northamerica-northeast2:acme-app-db"
      database_version = "POSTGRES_16"
      settings         = [{ ip_configuration = [{ ipv4_enabled = true }] }]
    }
  }

  assert {
    condition     = length(google_sql_database_instance.kindgi) == 0 && length(data.google_sql_database_instance.host) == 1
    error_message = "database_host_instance makes no instance of our own and reads the host."
  }
  assert {
    condition     = google_sql_database.kindgi.instance == "acme-app-db"
    error_message = "Kindgi's database is created on the host instance."
  }
  assert {
    condition     = google_sql_database.kindgi.deletion_policy == "ABANDON"
    error_message = "On a host, with deletion protection on, the database object is abandoned, not dropped."
  }
  assert {
    condition     = google_cloud_run_v2_service.server.template[0].volumes[0].cloud_sql_instance[0].instances == toset(["acme-app-dev:northamerica-northeast2:acme-app-db"])
    error_message = "The /cloudsql volume names the host instance's connection name."
  }
  assert {
    condition     = output.sql_connection_name == "acme-app-dev:northamerica-northeast2:acme-app-db"
    error_message = "sql_connection_name is the host instance's connection name."
  }
  assert {
    condition     = google_project_iam_member.server_sql_client[0].condition[0].expression == "resource.name == \"projects/acme-app-dev/instances/acme-app-db\""
    error_message = "The server's account may connect to the host instance."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].secret
      if e.name == "KINDGI_DATABASE_URL"
    ]) == "kindgi-dev-database-url"
    error_message = "KINDGI_DATABASE_URL reuses the module's own database-url secret; the operator points it at the host."
  }
}

run "the_instance_is_protected_from_deletion_by_default" {
  command = plan

  assert {
    condition     = google_sql_database_instance.kindgi[0].deletion_protection == true
    error_message = "Terraform's deletion protection should be on by default."
  }
  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].deletion_protection_enabled == true
    error_message = "Google's deletion protection should be on by default, beside Terraform's."
  }
}

run "protection_off_turns_both_flags_off" {
  command = plan

  variables {
    database_deletion_protection = false
  }

  assert {
    condition     = google_sql_database_instance.kindgi[0].deletion_protection == false
    error_message = "false should turn Terraform's deletion protection off."
  }
  assert {
    condition     = google_sql_database_instance.kindgi[0].settings[0].deletion_protection_enabled == false
    error_message = "false should turn Google's deletion protection off too, so a destroy can delete the instance."
  }
}

run "host_deletes_the_database_when_protection_is_off" {
  command = plan
  variables {
    database_host_instance       = "acme-app-db"
    database_deletion_protection = false
  }
  assert {
    condition     = google_sql_database.kindgi.deletion_policy == "DELETE"
    error_message = "With deletion protection off, the database object is deleted on a host too."
  }
}

run "host_refuses_a_pre_16_instance" {
  command = plan
  variables {
    database_host_instance = "acme-app-db"
  }
  override_data {
    target = data.google_sql_database_instance.host
    values = {
      database_version = "POSTGRES_15"
      settings         = [{ ip_configuration = [{ ipv4_enabled = true }] }]
    }
  }
  expect_failures = [data.google_sql_database_instance.host]
}

run "host_refuses_an_instance_without_a_public_ip" {
  command = plan
  variables {
    database_host_instance = "acme-app-db"
  }
  override_data {
    target = data.google_sql_database_instance.host
    values = {
      database_version = "POSTGRES_16"
      settings         = [{ ip_configuration = [{ ipv4_enabled = false }] }]
    }
  }
  expect_failures = [data.google_sql_database_instance.host]
}

run "host_refuses_a_backup_location" {
  command = plan
  variables {
    database_host_instance   = "acme-app-db"
    database_backup_location = "us"
  }
  expect_failures = [data.google_sql_database_instance.host]
}

run "host_refuses_a_backup_retention" {
  command = plan
  variables {
    database_host_instance    = "acme-app-db"
    database_backup_retention = 30
  }
  expect_failures = [data.google_sql_database_instance.host]
}

run "host_refuses_point_in_time_days" {
  command = plan
  variables {
    database_host_instance      = "acme-app-db"
    database_point_in_time_days = 3
  }
  expect_failures = [data.google_sql_database_instance.host]
}

run "host_refuses_private_ip_mode" {
  command = plan
  variables {
    database_host_instance   = "acme-app-db"
    database_private_network = "projects/acme-app-dev/global/networks/acme"
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "host_refuses_the_module_instance_name" {
  command = plan
  variables {
    database_host_instance = "kindgi-dev"
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "host_refuses_serving_from_itself" {
  command = plan
  variables {
    database_host_instance = "acme-app-db"
    database_instance = {
      name       = "acme-app-db"
      url_secret = "acme-app-db-url"
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "host_refuses_a_connection_name" {
  command = plan
  variables {
    database_host_instance = "acme-app-dev:northamerica-northeast2:db"
  }
  expect_failures = [var.database_host_instance]
}

# ---- network_mode = "none": no VPC ------------------------------------------

run "none_creates_no_vpc" {
  command = plan
  variables {
    network_mode = "none"
    pack_ingress = "INGRESS_TRAFFIC_ALL"
  }
  assert {
    condition     = length(google_compute_network.kindgi) == 0 && length(google_compute_router_nat.nat) == 0
    error_message = "network_mode = \"none\" creates no VPC and no NAT."
  }
  assert {
    condition     = local.pack_service_settings.egress.kind == "none"
    error_message = "The orchestrator gives each pack service no connector under \"none\"."
  }
  assert {
    condition     = length(google_cloud_run_v2_service.server.template[0].vpc_access) == 0
    error_message = "The server gets no VPC egress under \"none\"."
  }
}

run "none_needs_all_pack_ingress" {
  command = plan
  variables {
    network_mode = "none"
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "none_refuses_private_ip_mode" {
  command = plan
  variables {
    network_mode             = "none"
    pack_ingress             = "INGRESS_TRAFFIC_ALL"
    database_private_network = "projects/acme-app-dev/global/networks/acme"
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "none_refuses_a_static_nat_ip" {
  command = plan
  variables {
    network_mode  = "none"
    pack_ingress  = "INGRESS_TRAFFIC_ALL"
    nat_static_ip = true
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "connector_plans_with_a_static_nat_ip" {
  command = plan
  variables {
    network_mode  = "connector"
    vpc_connector = "projects/acme-app-dev/locations/northamerica-northeast2/connectors/acme"
    pack_ingress  = "INGRESS_TRAFFIC_ALL"
    nat_static_ip = true
  }
  assert {
    condition     = length(google_compute_address.nat) == 0
    error_message = "connector mode creates no Cloud NAT, so nat_static_ip reserves nothing and the plan does not refuse it."
  }
}

# ---- Cloud NAT ports ---------------------------------------------------------

run "nat_ports_grow_on_demand_by_default" {
  command = plan

  assert {
    condition     = google_compute_router_nat.nat[0].enable_dynamic_port_allocation && !google_compute_router_nat.nat[0].enable_endpoint_independent_mapping
    error_message = "The NAT allocates ports dynamically, with endpoint-independent mapping off (dynamic allocation needs it off)."
  }
  assert {
    condition     = google_compute_router_nat.nat[0].min_ports_per_vm == 64 && google_compute_router_nat.nat[0].max_ports_per_vm == 4096
    error_message = "Each instance should start with 64 NAT ports and grow to at most 4096 by default."
  }
  assert {
    condition     = google_compute_router_nat.nat[0].tcp_time_wait_timeout_sec == 30
    error_message = "A closed TCP connection's NAT port should come free after 30 s by default, not the provider's 120."
  }
}

run "nat_ports_follow_the_variables" {
  command = plan
  variables {
    nat_min_ports_per_vm          = 1024
    nat_max_ports_per_vm          = 65536
    nat_tcp_time_wait_timeout_sec = 120
  }
  assert {
    condition     = google_compute_router_nat.nat[0].min_ports_per_vm == 1024 && google_compute_router_nat.nat[0].max_ports_per_vm == 65536 && google_compute_router_nat.nat[0].tcp_time_wait_timeout_sec == 120
    error_message = "The NAT should take its ports and TIME_WAIT from nat_min_ports_per_vm, nat_max_ports_per_vm and nat_tcp_time_wait_timeout_sec."
  }
}

run "nat_min_ports_must_be_a_power_of_two" {
  command = plan
  variables {
    nat_min_ports_per_vm = 100
  }
  expect_failures = [var.nat_min_ports_per_vm]
}

run "nat_max_ports_must_be_a_power_of_two" {
  command = plan
  variables {
    nat_max_ports_per_vm = 5000
  }
  expect_failures = [var.nat_max_ports_per_vm]
}

run "nat_max_ports_must_be_above_the_minimum" {
  command = plan
  variables {
    nat_min_ports_per_vm = 4096
    nat_max_ports_per_vm = 4096
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "nat_ports_are_not_checked_without_a_nat" {
  command = plan
  variables {
    network_mode         = "connector"
    vpc_connector        = "projects/acme-app-dev/locations/northamerica-northeast2/connectors/acme"
    pack_ingress         = "INGRESS_TRAFFIC_ALL"
    nat_min_ports_per_vm = 4096
    nat_max_ports_per_vm = 4096
  }
  assert {
    condition     = length(google_compute_router_nat.nat) == 0
    error_message = "connector mode creates no Cloud NAT, so the plan does not check its ports."
  }
}

run "nat_time_wait_must_be_whole_seconds" {
  command = plan
  variables {
    nat_tcp_time_wait_timeout_sec = 0.5
  }
  expect_failures = [var.nat_tcp_time_wait_timeout_sec]
}

run "the_idle_backstop_is_ten_minutes_by_default" {
  command = plan

  assert {
    condition     = contains([for f in google_sql_database_instance.kindgi[0].settings[0].database_flags : "${f.name}=${f.value}"], "idle_in_transaction_session_timeout=600000")
    error_message = "The instance's idle_in_transaction_session_timeout should be 600000 ms by default."
  }
  assert {
    condition     = contains([for f in google_sql_database_instance.kindgi[0].settings[0].database_flags : "${f.name}=${f.value}"], "cloudsql.iam_authentication=on")
    error_message = "IAM authentication should stay on beside it."
  }
}

run "zero_turns_the_idle_backstop_off" {
  command = plan

  variables {
    database_idle_in_transaction_timeout_ms = 0
  }

  assert {
    condition     = contains([for f in google_sql_database_instance.kindgi[0].settings[0].database_flags : "${f.name}=${f.value}"], "idle_in_transaction_session_timeout=0")
    error_message = "0 should set the flag to 0, Postgres's off."
  }
}

run "an_idle_backstop_below_zero_is_refused" {
  command = plan

  variables {
    database_idle_in_transaction_timeout_ms = -1
  }

  expect_failures = [var.database_idle_in_transaction_timeout_ms]
}

run "an_idle_backstop_past_cloud_sqls_range_is_refused" {
  command = plan

  variables {
    database_idle_in_transaction_timeout_ms = 2147483648
  }

  expect_failures = [var.database_idle_in_transaction_timeout_ms]
}

run "an_idle_backstop_in_part_milliseconds_is_refused" {
  command = plan

  variables {
    database_idle_in_transaction_timeout_ms = 1.5
  }

  expect_failures = [var.database_idle_in_transaction_timeout_ms]
}


# ---- README step 1: the first apply, with only its targets -----------------
# Step 3 reads `terraform output -raw sql_connection_name`: an output is only
# written by a targeted apply when every resource it reads is in the targets'
# graph.

run "the_first_apply_gives_the_connection_name_on_a_host" {
  command = apply
  variables {
    database_host_instance = "acme-app-db"
  }
  override_data {
    target = data.google_sql_database_instance.host
    values = {
      connection_name  = "acme-app-dev:northamerica-northeast2:acme-app-db"
      database_version = "POSTGRES_16"
      settings         = [{ ip_configuration = [{ ipv4_enabled = true }] }]
    }
  }
  plan_options {
    target = [
      google_project_service.apis,
      google_compute_router_nat.nat,
      google_artifact_registry_repository_iam_member.server_reads_images,
      google_kms_crypto_key_iam_member.server_wraps,
      google_sql_database.kindgi,
      google_secret_manager_secret_iam_member.server_reads,
      google_project_iam_member.server_sql_client,
    ]
  }

  assert {
    condition     = output.sql_connection_name == "acme-app-dev:northamerica-northeast2:acme-app-db"
    error_message = "README step 1's apply leaves sql_connection_name in state (the host's), for step 3."
  }
}

run "the_first_apply_gives_the_connection_name_of_the_own_instance" {
  command = apply
  plan_options {
    target = [
      google_project_service.apis,
      google_compute_router_nat.nat,
      google_artifact_registry_repository_iam_member.server_reads_images,
      google_kms_crypto_key_iam_member.server_wraps,
      google_sql_database.kindgi,
      google_secret_manager_secret_iam_member.server_reads,
      google_project_iam_member.server_sql_client,
    ]
  }

  assert {
    condition     = output.sql_connection_name == google_sql_database_instance.kindgi[0].connection_name
    error_message = "README step 1's apply leaves sql_connection_name in state (the module's own instance's), for step 3."
  }
}

run "the_first_apply_checks_the_host" {
  command = plan
  variables {
    database_host_instance = "acme-app-db"
  }
  override_data {
    target = data.google_sql_database_instance.host
    values = {
      database_version = "POSTGRES_15"
      settings         = [{ ip_configuration = [{ ipv4_enabled = true }] }]
    }
  }
  plan_options {
    target = [
      google_project_service.apis,
      google_compute_router_nat.nat,
      google_artifact_registry_repository_iam_member.server_reads_images,
      google_kms_crypto_key_iam_member.server_wraps,
      google_sql_database.kindgi,
      google_secret_manager_secret_iam_member.server_reads,
      google_project_iam_member.server_sql_client,
    ]
  }
  expect_failures = [data.google_sql_database_instance.host]
}
