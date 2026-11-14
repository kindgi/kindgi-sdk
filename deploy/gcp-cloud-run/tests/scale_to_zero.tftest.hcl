# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# server_billing = "request": the server's CPU only during requests, its
# minimum instances at 0, and Cloud Scheduler's tick each minute; and what
# that needs. `terraform init -backend=false && terraform test` in the
# module's folder, against a mock Google provider.

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

run "by_default_the_cpu_stays_and_nothing_ticks" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_service.server.template[0].containers[0].resources[0].cpu_idle == false
    error_message = "By default the server's CPU stays allocated between requests."
  }
  assert {
    condition     = google_cloud_run_v2_service.server.template[0].scaling[0].min_instance_count == 1
    error_message = "By default the server keeps one instance."
  }
  assert {
    condition     = length(google_cloud_scheduler_job.tick) == 0 && length(google_service_account.tick) == 0
    error_message = "By default there is no tick, and no account for it."
  }
  assert {
    condition = alltrue([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : !contains(["KINDGI_TICK_CALLER", "KINDGI_SERVICE_URL"], e.name)
    ])
    error_message = "By default the server gets no tick settings."
  }
}

run "request_billing_at_zero_ticks_each_minute" {
  command = apply

  variables {
    server_billing       = "request"
    server_min_instances = 0
  }

  assert {
    condition     = google_cloud_run_v2_service.server.template[0].containers[0].resources[0].cpu_idle == true
    error_message = "Under request billing the server has CPU only during requests."
  }
  assert {
    condition     = google_cloud_run_v2_service.server.template[0].scaling[0].min_instance_count == 0
    error_message = "Under request billing the server may keep no instance."
  }
  assert {
    condition     = google_service_account.tick[0].account_id == "kindgi-dev-tick"
    error_message = "The tick has an account of its own."
  }
  assert {
    condition = (
      google_cloud_scheduler_job.tick[0].name == "kindgi-dev-server-tick" &&
      google_cloud_scheduler_job.tick[0].schedule == "* * * * *" &&
      google_cloud_scheduler_job.tick[0].time_zone == "Etc/UTC" &&
      google_cloud_scheduler_job.tick[0].attempt_deadline == "1800s" &&
      length(google_cloud_scheduler_job.tick[0].retry_config) == 0 &&
      google_cloud_scheduler_job.tick[0].http_target[0].http_method == "POST" &&
      google_cloud_scheduler_job.tick[0].http_target[0].uri == "https://kindgi-dev-server-123456789012.northamerica-northeast2.run.app/internal/tick"
    )
    error_message = "Cloud Scheduler posts to the server's tick each minute, with no retry and its longest deadline."
  }
  assert {
    condition = (
      google_cloud_scheduler_job.tick[0].http_target[0].oidc_token[0].audience == "https://kindgi-dev-server-123456789012.northamerica-northeast2.run.app/internal/tick" &&
      google_cloud_scheduler_job.tick[0].http_target[0].oidc_token[0].service_account_email == google_service_account.tick[0].email
    )
    error_message = "The tick carries an ID token of the tick's account, for the tick's URL."
  }
  assert {
    condition = (
      { for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name => e.value }["KINDGI_TICK_CALLER"] == google_service_account.tick[0].email &&
      { for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name => e.value }["KINDGI_SERVICE_URL"] == "https://kindgi-dev-server-123456789012.northamerica-northeast2.run.app"
    )
    error_message = "The server takes the tick from the tick's account, at its own run.app URL."
  }
  assert {
    condition = alltrue([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : contains(local.server_module_env, e.name)
    ])
    error_message = "A name the module sets on the server is missing from server_module_env."
  }
}

run "request_billing_behind_invoker_iam_off" {
  command = plan

  variables {
    server_billing              = "request"
    server_min_instances        = 0
    server_public               = false
    server_invoker_iam_disabled = true
  }

  assert {
    condition     = google_cloud_run_v2_service.server.template[0].containers[0].resources[0].cpu_idle == true && length(google_cloud_scheduler_job.tick) == 1
    error_message = "With Cloud Run IAM off rather than allUsers, request billing and the tick are the same."
  }
}

run "zero_instances_need_request_billing" {
  command = plan

  variables {
    server_min_instances = 0
  }

  expect_failures = [google_cloud_run_v2_service.server]
}

run "request_billing_needs_all_ingress" {
  command = plan

  variables {
    server_billing = "request"
    server_ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
    public_url     = "https://kindgi.acme.example"
  }

  expect_failures = [google_cloud_run_v2_service.server]
}

run "request_billing_needs_one_instance_at_most" {
  command = plan

  variables {
    server_billing       = "request"
    server_max_instances = 2
  }

  expect_failures = [google_cloud_run_v2_service.server]
}

run "request_billing_needs_cloud_run_iam_off" {
  command = plan

  variables {
    server_billing = "request"
    server_public  = false
  }

  expect_failures = [google_cloud_run_v2_service.server]
}

run "server_env_cannot_set_the_tick_settings" {
  command = plan

  variables {
    server_billing = "request"
    server_env     = { KINDGI_SERVICE_URL = "https://kindgi.acme.example" }
  }

  expect_failures = [google_cloud_run_v2_service.server]
}

run "billing_is_instance_or_request" {
  command = plan

  variables {
    server_billing = "always"
  }

  expect_failures = [var.server_billing]
}

run "min_instances_is_a_whole_number" {
  command = plan

  variables {
    server_min_instances = 1.5
  }

  expect_failures = [var.server_min_instances]
}
