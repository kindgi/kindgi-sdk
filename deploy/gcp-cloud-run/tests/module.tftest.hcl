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
  pack_image              = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/acme-app@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  seed_tenant_id          = "00000000-0000-0000-0000-000000000001"
  seed_user_id            = "00000000-0000-0000-0000-000000000002"
  secrets_aad_key_version = "1"
}

run "defaults_keep_kms_and_the_own_repository" {
  command = plan

  assert {
    condition     = length(google_kms_crypto_key.secrets) == 1 && length(google_kms_key_ring.kindgi) == 1
    error_message = "The default secrets backend (postgres) has a KMS key."
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

run "secrets_backend_none_has_no_kms" {
  command = plan

  variables {
    secrets_backend         = "none"
    secrets_aad_key_version = null
  }

  assert {
    condition     = length(google_kms_crypto_key.secrets) == 0 && length(google_kms_key_ring.kindgi) == 0
    error_message = "secrets_backend = none creates no KMS key ring or key."
  }
  assert {
    condition     = length(google_kms_crypto_key_iam_member.server_wraps) == 0 && length(google_kms_crypto_key_iam_member.server_reads_key) == 0
    error_message = "secrets_backend = none grants nothing on a key."
  }
  assert {
    condition     = !contains(keys(google_secret_manager_secret.server), "secrets_aad_key")
    error_message = "secrets_backend = none has no AAD-key secret."
  }
  assert {
    condition     = !contains(keys(google_project_service.apis), "cloudkms.googleapis.com")
    error_message = "secrets_backend = none doesn't enable Cloud KMS."
  }
  assert {
    condition = length([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name
      if startswith(e.name, "KINDGI_SECRETS_")
    ]) == 0
    error_message = "secrets_backend = none sets no KINDGI_SECRETS_* variable on the server."
  }
}

run "postgres_needs_the_aad_key_version" {
  command = plan

  variables {
    secrets_aad_key_version = null
  }

  expect_failures = [google_cloud_run_v2_service.server]
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
  # known. Without KMS: the key's prevent_destroy would stop the teardown.
  command = apply

  variables {
    secrets_backend         = "none"
    secrets_aad_key_version = null
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
      g.role == "roles/run.invoker" && g.member == "serviceAccount:${google_service_account.pack[0].email}"
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

# ---- tenancy ------------------------------------------------------------------

# "single", the default: the tenant, the seed user and the one pack service,
# as before tenancy existed.
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

run "with_a_pack_image_the_server_calls_the_one_pack_service" {
  command = plan

  assert {
    condition     = length(google_cloud_run_v2_service.pack) == 1 && length(google_service_account.pack) == 1 && length(google_cloud_run_v2_service_iam_member.server_invokes_pack) == 1
    error_message = "With pack_image: the pack service, its account, and the server's invoker grant, as before."
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name], "KINDGI_PACK_SERVICE_URL")
    error_message = "The server calls the pack service at its URL."
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.pack_reads_token) == 1 && length(google_secret_manager_secret.shared) == 1
    error_message = "The shared pack token exists, and the pack service reads it."
  }
  assert {
    condition     = length(setintersection(toset([for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name]), toset(["KINDGI_PACK_SERVICE_TOKEN", "KINDGI_PACK_SERVICE_AUTH"]))) == 2
    error_message = "The server calls the pack service with the shared token and an ID token."
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

run "single_needs_a_pack_image" {
  command = plan
  variables {
    pack_image = ""
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "single_refuses_per_deployment_routing" {
  command = plan
  variables {
    server_env = { KINDGI_PACK_ROUTING = "per-deployment" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "single_takes_a_padded_single_routing" {
  command = plan
  variables {
    server_env = { KINDGI_PACK_ROUTING = " single " }
  }
}

run "single_takes_an_empty_routing" {
  command = plan
  variables {
    server_env = { KINDGI_PACK_ROUTING = "" }
  }
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
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
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

run "multi_has_no_pack_service" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  assert {
    condition     = length(google_cloud_run_v2_service.pack) == 0 && length(google_service_account.pack) == 0 && length(google_cloud_run_v2_service_iam_member.server_invokes_pack) == 0
    error_message = "With tenancy = \"multi\": no pack service, no pack account, no invoker grant."
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.pack_reads_token) == 0 && length(google_secret_manager_secret_iam_member.pack_reads_its_secrets) == 0
    error_message = "No pack account, so none of its secret grants."
  }
  assert {
    condition     = length(setintersection(toset([for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name]), toset(["KINDGI_PACK_SERVICE_URL", "KINDGI_PACK_SERVICE_TOKEN", "KINDGI_PACK_SERVICE_AUTH"]))) == 0 && length(google_secret_manager_secret.shared) == 0
    error_message = "No pack service, so none of its URL, shared token or auth: each deployment's endpoint carries its own, and the server refuses these."
  }
  assert {
    condition     = output.pack_service_url == null && output.service_accounts.pack == null
    error_message = "No pack service URL or account in the outputs."
  }
}

run "multi_in_connector_mode_needs_no_public_pack_ingress" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
    network_mode  = "connector"
    vpc_connector = "projects/acme-app-dev/locations/northamerica-northeast2/connectors/acme"
  }
  assert {
    condition     = length(google_cloud_run_v2_service.pack) == 0
    error_message = "Connector mode plans without a pack service, whatever pack_ingress says."
  }
}

run "multi_refuses_a_pack_image" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
    pack_image = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/acme-app@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_refuses_pack_settings" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
    pack_env = { ACME_MODE = "live" }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_refuses_a_seed_tenant" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_user_id    = null
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
    seed_tenant_id = "00000000-0000-0000-0000-000000000001"
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_refuses_a_seed_user" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
    seed_user_id = "00000000-0000-0000-0000-000000000002"
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_needs_openfga" {
  command = plan
  variables {
    tenancy        = "multi"
    seed_tenant_id = null
    seed_user_id   = null
    pack_image     = ""
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
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
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
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
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_needs_per_deployment_routing" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_needs_the_endpoint_hosts" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS = "isolated"
      KINDGI_PACK_ROUTING       = "per-deployment"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
  }
  expect_failures = [google_cloud_run_v2_service.server]
}

run "multi_needs_the_postgres_secrets_backend" {
  command = plan
  variables {
    tenancy         = "multi"
    seed_tenant_id  = null
    seed_user_id    = null
    pack_image      = ""
    openfga_api_url = "https://openfga-acme.a.run.app"
    server_env = {
      KINDGI_TENANT_HOST_ACCESS  = "isolated"
      KINDGI_PACK_ROUTING        = "per-deployment"
      KINDGI_PACK_ENDPOINT_HOSTS = "*.packs.acme.example"
    }
    server_secret_env = {
      KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
    }
    secrets_backend         = "none"
    secrets_aad_key_version = null
  }
  expect_failures = [google_cloud_run_v2_service.server]
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
    condition     = length(google_cloud_run_v2_service.pack[0].template[0].vpc_access) == 0
    error_message = "The pack service gets no connector under \"none\"."
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
