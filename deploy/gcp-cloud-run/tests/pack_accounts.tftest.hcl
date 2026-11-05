# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# A pack account per tenant (pack_accounts = "per-tenant", tenants.tf): each
# tenant's account and what it reads, the orchestrator's act-as, the Job's
# env, and the checks. `terraform init -backend=false && terraform test` in
# this folder, against a mock Google provider. A file of its own: every run
# here is in multi tenancy with two tenants unless it says otherwise.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
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

# Tenant A is 8d3e5f1a-…, tenant B is 1a2b3c4d-…. Their keys under
# kindgi-dev: kp-t + the first 16 hex digits of
# sha256("kindgi-dev/<id>"), kp-tfb2ca4107236eb13 and kp-t72d92a01672c734f.
variables {
  project_id               = "acme-app-dev"
  region                   = "northamerica-northeast2"
  name_prefix              = "kindgi-dev"
  kindgi_env               = "dev"
  server_image             = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  secrets_aad_key_version  = "1"
  orchestrator_key_version = "1"
  tenancy                  = "multi"
  openfga_api_url          = "https://openfga-acme.a.run.app"
  server_env = {
    KINDGI_TENANT_HOST_ACCESS = "isolated"
  }
  server_secret_env = {
    KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-dev-openfga-key", version = "1" }
  }
  pack_accounts = "per-tenant"
  pack_tenants  = ["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd", "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"]
}

run "each_tenant_gets_an_account_with_a_known_key" {
  command = plan

  assert {
    condition     = toset(keys(google_service_account.tenant)) == toset(["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd", "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"])
    error_message = "Each tenant in pack_tenants gets an account, keyed by its id."
  }
  assert {
    condition = (
      google_service_account.tenant["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].account_id == "kp-tfb2ca4107236eb13" &&
      google_service_account.tenant["1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"].account_id == "kp-t72d92a01672c734f"
    )
    error_message = "A tenant's account id is kp-t and the first 16 hex digits of sha256(\"<name_prefix>/<id>\")."
  }
  assert {
    condition     = google_service_account.tenant["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].display_name == "Kindgi pack services: tenant 8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"
    error_message = "A tenant's account says whose it is."
  }
  assert {
    condition     = length(google_service_account.pack) == 1 && length(google_project_iam_member.pack_reads_pack_secrets) == 1 && length(google_service_account_iam_member.orchestrator_acts_as_pack) == 1
    error_message = "The pack account and its grants stay while pack_shared_account is true: it serves until every service has moved."
  }
}

run "another_installation_name_gives_another_key" {
  command = plan

  variables {
    name_prefix = "kindgi-prod"
  }

  assert {
    condition     = google_service_account.tenant["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].account_id == "kp-t3bb9e053cc47dc93"
    error_message = "The installation's name is in the hash, so two installations never share a tenant's account."
  }
}

run "an_id_in_another_case_keeps_every_address" {
  command = plan

  variables {
    pack_tenants = ["8D3E5F1A-2B4C-4D6E-8F01-23456789ABCD", "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"]
  }

  assert {
    condition = (
      contains(keys(google_service_account.tenant), "8d3e5f1a-2b4c-4d6e-8f01-23456789abcd") &&
      google_service_account.tenant["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].account_id == "kp-tfb2ca4107236eb13" &&
      contains(keys(google_project_iam_member.tenant_reads_own_secrets), "8d3e5f1a-2b4c-4d6e-8f01-23456789abcd")
    )
    error_message = "Every tenant resource is keyed by the id in lower case, and the key hashes it, so an edit to an id's case replaces nothing."
  }
}

run "each_tenant_reads_only_its_own_secrets" {
  # Applied against the mock, so the pack account's email is known.
  command = apply

  assert {
    condition = (
      google_project_iam_member.tenant_reads_own_secrets["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].role == "roles/secretmanager.secretAccessor" &&
      google_project_iam_member.tenant_reads_own_secrets["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].member == "serviceAccount:kp-tfb2ca4107236eb13@acme-app-dev.iam.gserviceaccount.com" &&
      google_project_iam_member.tenant_reads_own_secrets["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].condition[0].expression == "resource.name.startsWith(\"projects/123456789012/secrets/kp-tfb2ca4107236eb13-\")"
    )
    error_message = "A tenant's account reads the secrets under its own prefix, kp-t<16 hex>-, and a startsWith with no logic operator."
  }
  assert {
    condition = alltrue([
      for g in google_project_iam_member.tenant_reads_own_secrets :
      g.condition[0].title == "kindgi-tenant-secrets-only" && g.condition[0].description == "This tenant's pack services' own secrets (kp-t...-) only."
    ])
    error_message = "Every tenant's grant has the same fixed title and description, so a later edit replaces no grant."
  }
  assert {
    condition = alltrue([
      for g in google_project_iam_member.tenant_reads_own_secrets :
      g.condition[0].expression != "resource.name.startsWith(\"projects/123456789012/secrets/kp-\")"
    ])
    error_message = "No tenant's account reads every kp- secret."
  }
  assert {
    condition     = google_project_iam_member.pack_reads_pack_secrets[0].member == "serviceAccount:kindgi-dev-pack@acme-app-dev.iam.gserviceaccount.com"
    error_message = "The project-wide kp- read is the pack account's alone."
  }
}

run "the_orchestrator_acts_as_each_tenant" {
  # Applied against the mock, so the orchestrator's email is known.
  command = apply

  assert {
    condition = (
      google_service_account_iam_member.orchestrator_acts_as_tenant["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].service_account_id == "projects/acme-app-dev/serviceAccounts/kp-tfb2ca4107236eb13@acme-app-dev.iam.gserviceaccount.com" &&
      google_service_account_iam_member.orchestrator_acts_as_tenant["1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"].service_account_id == "projects/acme-app-dev/serviceAccounts/kp-t72d92a01672c734f@acme-app-dev.iam.gserviceaccount.com"
    )
    error_message = "The orchestrator gets act-as on each tenant's account, that account only."
  }
  assert {
    condition = alltrue([
      for g in google_service_account_iam_member.orchestrator_acts_as_tenant :
      g.role == "roles/iam.serviceAccountUser" && g.member == "serviceAccount:${google_service_account.orchestrator.email}" && !strcontains(g.service_account_id, "-server@")
    ])
    error_message = "Each act-as is the orchestrator's serviceAccountUser, never on the server's account."
  }
}

run "without_the_shared_account_the_orchestrator_acts_as_no_pack_account" {
  command = plan

  variables {
    pack_shared_account = false
  }

  assert {
    condition = (
      length(google_service_account.pack) == 0 &&
      length(google_service_account_iam_member.orchestrator_acts_as_pack) == 0 &&
      length(google_project_iam_member.pack_reads_pack_secrets) == 0 &&
      length(google_secret_manager_secret_iam_member.pack_reads_cloud_secrets) == 0 &&
      length(google_project_iam_member.pack_sql_client) == 0 &&
      length(google_storage_bucket_iam_member.pack_reads) == 0 &&
      length(google_cloud_run_v2_service_iam_member.pack_invokes) == 0
    )
    error_message = "pack_shared_account = false takes the pack account and every grant of it away."
  }
  assert {
    condition     = length(google_service_account_iam_member.orchestrator_acts_as_tenant) == 2
    error_message = "The tenants' accounts and the orchestrator's act-as on them stay."
  }
  assert {
    condition     = output.service_accounts.pack == null && length(output.service_accounts.tenants) == 2
    error_message = "service_accounts names no pack account once it's gone."
  }
}

run "a_listed_secret_binds_only_its_tenants" {
  command = plan

  variables {
    pack_secret_readers = [
      { secret = "acme-orders-key", tenants = ["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"] },
      { secret = "acme-ocr-key", project = "acme-shared", tenants = ["8D3E5F1A-2B4C-4D6E-8F01-23456789ABCD", "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"] },
    ]
  }

  assert {
    condition = toset(keys(google_secret_manager_secret_iam_member.tenant_reads_cloud_secrets)) == toset([
      "projects/acme-app-dev/secrets/acme-orders-key|8d3e5f1a-2b4c-4d6e-8f01-23456789abcd",
      "projects/acme-shared/secrets/acme-ocr-key|8d3e5f1a-2b4c-4d6e-8f01-23456789abcd",
      "projects/acme-shared/secrets/acme-ocr-key|1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
    ])
    error_message = "Each listed secret is read by the tenants its entry lists, and no others."
  }
  assert {
    condition = (
      google_secret_manager_secret_iam_member.tenant_reads_cloud_secrets["projects/acme-app-dev/secrets/acme-orders-key|8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].member == "serviceAccount:kp-tfb2ca4107236eb13@acme-app-dev.iam.gserviceaccount.com" &&
      google_secret_manager_secret_iam_member.tenant_reads_cloud_secrets["projects/acme-shared/secrets/acme-ocr-key|1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"].member == "serviceAccount:kp-t72d92a01672c734f@acme-app-dev.iam.gserviceaccount.com"
    )
    error_message = "Each grant is on the secret's own policy, for that tenant's account."
  }
}

run "the_tenants_share_one_cloud_sql_condition" {
  command = plan

  variables {
    pack_cloud_sql_instances = ["acme-app-dev:northamerica-northeast2:acme-orders", "acme-shared:us-central1:acme-ocr"]
  }

  assert {
    condition = alltrue([
      for g in google_project_iam_member.tenant_sql_client :
      g.role == "roles/cloudsql.client" &&
      g.condition[0].title == "kindgi-pack-instances-only" &&
      g.condition[0].description == "The Cloud SQL instances the pack services connect to (pack_cloud_sql_instances) only." &&
      g.condition[0].expression == "resource.name == \"projects/acme-app-dev/instances/acme-orders\" || resource.name == \"projects/acme-shared/instances/acme-ocr\""
    ]) && length(google_project_iam_member.tenant_sql_client) == 2
    error_message = "Every tenant's cloudsql.client has one condition on the listed instances, the same for every tenant, so the tenants are members of one binding."
  }
  assert {
    condition     = length(google_project_iam_member.pack_sql_client[0].condition) == 0
    error_message = "The pack account's cloudsql.client keeps no condition, as before."
  }
}

run "bucket_grants_keep_the_pack_accounts_condition" {
  command = plan

  variables {
    pack_bucket_readers         = ["acme-orders", "acme-media"]
    pack_bucket_object_prefixes = { "acme-media" = ["packs/", "shared/"] }
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.tenant_reads["acme-media|8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].condition[0].title == google_storage_bucket_iam_member.pack_reads["acme-media"].condition[0].title &&
      google_storage_bucket_iam_member.tenant_reads["acme-media|8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].condition[0].description == google_storage_bucket_iam_member.pack_reads["acme-media"].condition[0].description &&
      google_storage_bucket_iam_member.tenant_reads["acme-media|1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"].condition[0].expression == google_storage_bucket_iam_member.pack_reads["acme-media"].condition[0].expression
    )
    error_message = "A tenant's bucket grant has the pack account's title, description and expression: every tenant is a member of one binding."
  }
  assert {
    condition = (
      length(google_storage_bucket_iam_member.tenant_reads) == 4 &&
      length(google_storage_bucket_iam_member.tenant_reads["acme-orders|1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"].condition) == 0 &&
      google_storage_bucket_iam_member.tenant_reads["acme-orders|1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"].member == "serviceAccount:kp-t72d92a01672c734f@acme-app-dev.iam.gserviceaccount.com"
    )
    error_message = "Each tenant reads each listed bucket, a bucket with no prefixes whole."
  }
}

run "the_tenants_invoke_the_named_services" {
  command = plan

  variables {
    pack_run_invokers = [{ project = "acme-shared", location = "us-central1", service = "acme-ocr" }]
  }

  assert {
    condition = (
      toset(keys(google_cloud_run_v2_service_iam_member.tenant_invokes)) == toset([
        "acme-shared/us-central1/acme-ocr|8d3e5f1a-2b4c-4d6e-8f01-23456789abcd",
        "acme-shared/us-central1/acme-ocr|1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
      ]) &&
      google_cloud_run_v2_service_iam_member.tenant_invokes["acme-shared/us-central1/acme-ocr|8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.tenant_invokes["acme-shared/us-central1/acme-ocr|8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"].member == "serviceAccount:kp-tfb2ca4107236eb13@acme-app-dev.iam.gserviceaccount.com"
    )
    error_message = "Each tenant's account may invoke each pack_run_invokers service."
  }
}

# The env the orchestrator reads: the runtime's config test parses this same
# string.
run "the_job_names_each_tenants_account" {
  command = plan

  assert {
    condition = one([
      for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.value
      if e.name == "KINDGI_ORCHESTRATOR_TENANT_ACCOUNTS"
    ]) == "{\"1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d\":\"kp-t72d92a01672c734f@acme-app-dev.iam.gserviceaccount.com\",\"8d3e5f1a-2b4c-4d6e-8f01-23456789abcd\":\"kp-tfb2ca4107236eb13@acme-app-dev.iam.gserviceaccount.com\"}"
    error_message = "KINDGI_ORCHESTRATOR_TENANT_ACCOUNTS is a JSON object of each tenant id, in lower case, to its account."
  }
  assert {
    condition = one([
      for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.value
      if e.name == "KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT"
    ]) == "kindgi-dev-pack@acme-app-dev.iam.gserviceaccount.com"
    error_message = "KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT still names the pack account."
  }
}

run "without_the_shared_account_the_job_env_is_the_same" {
  command = plan

  variables {
    pack_shared_account = false
  }

  assert {
    condition = one([
      for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.value
      if e.name == "KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT"
    ]) == "kindgi-dev-pack@acme-app-dev.iam.gserviceaccount.com"
    error_message = "KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT is a string, the same once the pack account is gone."
  }
}

run "per_tenant_with_no_tenants_names_an_empty_map" {
  command = plan

  variables {
    pack_tenants = []
  }

  assert {
    condition = one([
      for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e.value
      if e.name == "KINDGI_ORCHESTRATOR_TENANT_ACCOUNTS"
    ]) == "{}"
    error_message = "Per-tenant with no tenant listed sets the env to {}: every tenant waits with tenant-not-provisioned."
  }
}

run "shared_mode_has_no_tenant_account_and_no_env" {
  # Applied against the mock, so the pack account's email is known.
  command = apply

  variables {
    pack_accounts = "shared"
    pack_tenants  = []
  }

  assert {
    condition = (
      length(google_service_account.tenant) == 0 &&
      length(google_project_iam_member.tenant_reads_own_secrets) == 0 &&
      length(google_service_account_iam_member.orchestrator_acts_as_tenant) == 0 &&
      length(google_service_account.pack) == 1
    )
    error_message = "Shared mode makes no tenant account: every pack service runs as the pack account."
  }
  assert {
    condition = length([
      for e in google_cloud_run_v2_job.orchestrator[0].template[0].template[0].containers[0].env : e
      if e.name == "KINDGI_ORCHESTRATOR_TENANT_ACCOUNTS"
    ]) == 0
    error_message = "Shared mode sets no KINDGI_ORCHESTRATOR_TENANT_ACCOUNTS."
  }
  assert {
    condition     = output.service_accounts.tenants == {} && output.service_accounts.pack == "kindgi-dev-pack@acme-app-dev.iam.gserviceaccount.com"
    error_message = "service_accounts names the pack account, and no tenant's."
  }
}

run "up_to_93_tenants_are_taken" {
  command = plan

  variables {
    pack_tenants = [for i in range(93) : format("00000000-0000-4000-8000-%012d", i)]
  }

  assert {
    condition     = length(google_service_account.tenant) == 93
    error_message = "An installation takes 93 tenants."
  }
}

# ---- what the checks refuse --------------------------------------------------------

run "a_94th_tenant_is_refused" {
  command = plan

  variables {
    pack_tenants = [for i in range(94) : format("00000000-0000-4000-8000-%012d", i)]
  }
  expect_failures = [google_service_account.orchestrator]
}

# Two distinct ids with one key can't be built (64 bits of a hash), so the
# key check is a guard only. An id repeated in another case is refused first.
run "a_tenant_repeated_in_another_case_is_refused" {
  command = plan

  variables {
    pack_tenants = ["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd", "8D3E5F1A-2B4C-4D6E-8F01-23456789ABCD"]
  }
  expect_failures = [var.pack_tenants]
}

run "a_tenant_that_isnt_a_uuid_is_refused" {
  command = plan

  variables {
    pack_tenants = ["acme"]
  }
  expect_failures = [var.pack_tenants]
}

run "a_mode_that_isnt_known_is_refused" {
  command = plan

  variables {
    pack_accounts = "per-project"
  }
  expect_failures = [var.pack_accounts]
}

run "per_tenant_with_one_tenancy_is_refused" {
  command = plan

  variables {
    tenancy           = "single"
    seed_tenant_id    = "00000000-0000-0000-0000-000000000001"
    seed_user_id      = "00000000-0000-0000-0000-000000000002"
    openfga_api_url   = ""
    server_env        = {}
    server_secret_env = {}
  }
  expect_failures = [google_service_account.orchestrator]
}

run "tenants_in_shared_mode_are_refused" {
  command = plan

  variables {
    pack_accounts = "shared"
  }
  expect_failures = [google_service_account.orchestrator]
}

run "no_shared_account_in_shared_mode_is_refused" {
  command = plan

  variables {
    pack_accounts       = "shared"
    pack_tenants        = []
    pack_shared_account = false
  }
  expect_failures = [google_service_account.orchestrator]
}

run "a_listed_secret_with_no_tenants_is_refused" {
  command = plan

  variables {
    pack_secret_readers = [{ secret = "acme-orders-key" }]
  }
  expect_failures = [google_service_account.orchestrator]
}

run "a_listed_secret_with_tenants_in_shared_mode_is_refused" {
  command = plan

  variables {
    pack_accounts       = "shared"
    pack_tenants        = []
    pack_secret_readers = [{ secret = "acme-orders-key", tenants = ["8d3e5f1a-2b4c-4d6e-8f01-23456789abcd"] }]
  }
  expect_failures = [google_service_account.orchestrator]
}

run "a_listed_secret_naming_a_tenant_not_listed_is_refused" {
  command = plan

  variables {
    pack_secret_readers = [{ secret = "acme-orders-key", tenants = ["0b6d1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4"] }]
  }
  expect_failures = [google_service_account.orchestrator]
}

run "a_cloud_sql_instance_that_isnt_a_connection_name_is_refused" {
  command = plan

  variables {
    pack_cloud_sql_instances = ["acme-orders"]
  }
  expect_failures = [google_service_account.orchestrator]
}
