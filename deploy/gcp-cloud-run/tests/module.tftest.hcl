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
