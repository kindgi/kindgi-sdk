# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# server_run_execution = "request": each run executes in a request of its
# own, which the run queue sends, so the server may run more than one
# instance; and server_concurrency, which the queue's cap follows.
# `terraform init -backend=false && terraform test` in the module's folder,
# against a mock Google provider.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
}

# The accounts as Google names them: a grant to act as one takes only that
# form, which the mock's own random name isn't.
override_resource {
  target = google_service_account.pack
  values = {
    name  = "projects/acme-app-dev/serviceAccounts/kindgi-dev-pack@acme-app-dev.iam.gserviceaccount.com"
    email = "kindgi-dev-pack@acme-app-dev.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.server
  values = {
    name  = "projects/acme-app-dev/serviceAccounts/kindgi-dev-server@acme-app-dev.iam.gserviceaccount.com"
    email = "kindgi-dev-server@acme-app-dev.iam.gserviceaccount.com"
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

run "by_default_runs_execute_where_they_start" {
  command = plan

  assert {
    condition = (
      length(google_cloud_tasks_queue.runs) == 0 &&
      length(google_cloud_tasks_queue_iam_member.server_enqueues) == 0 &&
      length(google_service_account_iam_member.server_acts_as_itself) == 0
    )
    error_message = "By default there is no run queue, and no grant for it."
  }
  assert {
    condition     = !contains(keys(google_project_service.apis), "cloudtasks.googleapis.com")
    error_message = "By default the Cloud Tasks API stays as it is."
  }
  assert {
    condition = alltrue([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : !contains(["KINDGI_RUN_EXECUTION", "KINDGI_SERVICE_ACCOUNT", "KINDGI_TASKS_QUEUE"], e.name)
    ])
    error_message = "By default the server gets none of the run queue's settings."
  }
  assert {
    condition     = google_cloud_run_v2_service.server.template[0].max_instance_request_concurrency == 80
    error_message = "By default an instance takes Cloud Run's own 80 requests at once."
  }
  assert {
    condition     = output.runs_queue == null
    error_message = "By default there is no run queue to name."
  }
}

run "request_execution_runs_three_instances" {
  command = apply

  variables {
    server_billing       = "request"
    server_min_instances = 0
    server_run_execution = "request"
    server_max_instances = 3
    server_concurrency   = 160
  }

  assert {
    condition = (
      google_cloud_run_v2_service.server.template[0].scaling[0].max_instance_count == 3 &&
      google_cloud_run_v2_service.server.template[0].max_instance_request_concurrency == 160
    )
    error_message = "Under request execution the server runs up to 3 instances, each taking 160 requests at once."
  }
  assert {
    condition = (
      google_cloud_tasks_queue.runs[0].name == "kindgi-dev-runs" &&
      google_cloud_tasks_queue.runs[0].location == "northamerica-northeast2"
    )
    error_message = "The run queue is <name_prefix>-runs, in the server's region."
  }
  assert {
    condition = (
      google_cloud_tasks_queue.runs[0].rate_limits[0].max_concurrent_dispatches == 480 &&
      google_cloud_tasks_queue.runs[0].rate_limits[0].max_dispatches_per_second == 500
    )
    error_message = "The queue sends as many requests at once as the instances take (3 x 160), at Cloud Tasks' highest rate."
  }
  assert {
    condition = (
      google_cloud_tasks_queue.runs[0].retry_config[0].max_attempts == 10 &&
      google_cloud_tasks_queue.runs[0].retry_config[0].min_backoff == "1s" &&
      google_cloud_tasks_queue.runs[0].retry_config[0].max_backoff == "60s" &&
      google_cloud_tasks_queue.runs[0].retry_config[0].max_doublings == 5
    )
    error_message = "The queue tries a task again for about four minutes, from 1 s apart up to 60 s."
  }
  assert {
    condition = (
      { for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name => e.value }["KINDGI_RUN_EXECUTION"] == "request" &&
      { for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name => e.value }["KINDGI_SERVICE_ACCOUNT"] == "kindgi-dev-server@acme-app-dev.iam.gserviceaccount.com" &&
      { for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name => e.value }["KINDGI_TASKS_QUEUE"] == "projects/acme-app-dev/locations/northamerica-northeast2/queues/kindgi-dev-runs" &&
      { for e in google_cloud_run_v2_service.server.template[0].containers[0].env : e.name => e.value }["KINDGI_SERVICE_URL"] == "https://kindgi-dev-server-123456789012.northamerica-northeast2.run.app"
    )
    error_message = "The server executes runs in requests, which the run queue sends to its own run.app URL with its own account's token."
  }
  assert {
    condition = (
      google_cloud_tasks_queue_iam_member.server_enqueues[0].name == "kindgi-dev-runs" &&
      google_cloud_tasks_queue_iam_member.server_enqueues[0].location == "northamerica-northeast2" &&
      google_cloud_tasks_queue_iam_member.server_enqueues[0].role == "roles/cloudtasks.enqueuer" &&
      google_cloud_tasks_queue_iam_member.server_enqueues[0].member == "serviceAccount:kindgi-dev-server@acme-app-dev.iam.gserviceaccount.com"
    )
    error_message = "The server's account may add tasks to the run queue, and only to it."
  }
  assert {
    condition = (
      google_service_account_iam_member.server_acts_as_itself[0].service_account_id == "projects/acme-app-dev/serviceAccounts/kindgi-dev-server@acme-app-dev.iam.gserviceaccount.com" &&
      google_service_account_iam_member.server_acts_as_itself[0].role == "roles/iam.serviceAccountUser" &&
      google_service_account_iam_member.server_acts_as_itself[0].member == "serviceAccount:kindgi-dev-server@acme-app-dev.iam.gserviceaccount.com"
    )
    error_message = "The server's account may act as itself, so its tasks' tokens may name it."
  }
  assert {
    condition     = contains(keys(google_project_service.apis), "cloudtasks.googleapis.com") && !google_project_service.apis["cloudtasks.googleapis.com"].disable_on_destroy
    error_message = "Request execution turns the Cloud Tasks API on, and taking it out of the module leaves it on."
  }
  assert {
    condition     = output.runs_queue == "projects/acme-app-dev/locations/northamerica-northeast2/queues/kindgi-dev-runs"
    error_message = "The output names the run queue in full."
  }
  assert {
    condition = alltrue([
      for e in google_cloud_run_v2_service.server.template[0].containers[0].env : contains(local.server_module_env, e.name)
    ])
    error_message = "A name the module sets on the server is missing from server_module_env."
  }
}

run "the_queue_sends_5000_at_once_at_most" {
  command = plan

  variables {
    server_billing       = "request"
    server_run_execution = "request"
    server_max_instances = 40
    server_concurrency   = 1000
  }

  assert {
    condition     = google_cloud_tasks_queue.runs[0].rate_limits[0].max_concurrent_dispatches == 5000
    error_message = "The queue's requests at once stop at Cloud Tasks' own maximum, 5000."
  }
}

run "request_execution_needs_request_billing" {
  command = plan

  variables {
    server_run_execution = "request"
  }

  expect_failures = [google_cloud_run_v2_service.server]
}

run "request_billing_alone_still_needs_one_instance" {
  command = plan

  variables {
    server_billing       = "request"
    server_run_execution = "local"
    server_max_instances = 2
  }

  expect_failures = [google_cloud_run_v2_service.server]
}

run "server_env_cannot_set_the_run_queue" {
  command = plan

  variables {
    server_billing       = "request"
    server_run_execution = "request"
    server_env           = { KINDGI_TASKS_QUEUE = "projects/acme-app-dev/locations/northamerica-northeast2/queues/other" }
  }

  expect_failures = [google_cloud_run_v2_service.server]
}

run "run_execution_is_local_or_request" {
  command = plan

  variables {
    server_run_execution = "tasks"
  }

  expect_failures = [var.server_run_execution]
}

run "concurrency_is_at_least_1" {
  command = plan

  variables {
    server_concurrency = 0
  }

  expect_failures = [var.server_concurrency]
}

run "concurrency_is_at_most_1000" {
  command = plan

  variables {
    server_concurrency = 1001
  }

  expect_failures = [var.server_concurrency]
}

run "concurrency_is_a_whole_number" {
  command = plan

  variables {
    server_concurrency = 1.5
  }

  expect_failures = [var.server_concurrency]
}

run "max_instances_is_a_whole_number" {
  command = plan

  variables {
    server_max_instances = 1.5
  }

  expect_failures = [var.server_max_instances]
}
