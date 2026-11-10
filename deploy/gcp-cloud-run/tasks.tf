# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The run queue, with server_run_execution = "request". There each run
# executes inside a request of its own, so a server whose CPU is allocated
# only during requests can run as many instances as its load needs, and any
# of them takes a run. The server doesn't send that request itself: a
# request lasts only while its client holds the connection, and the instance
# that sent it may be scaled in. It adds a task to this Cloud Tasks queue
# instead, which posts to the server's /internal/execute (and /internal/work
# and /internal/drain) with a Google-signed ID token of the server's own
# account, for that route's URL. The server checks the token itself, as it
# does the tick's (scheduler.tf).

locals {
  runs_in_requests = var.server_run_execution == "request"

  # The queue's full name, built from variables as server_service_url is: the
  # server's env has it before the queue is made.
  runs_queue_name = "${var.name_prefix}-runs"
  runs_queue      = "projects/${var.project_id}/locations/${var.region}/queues/${local.runs_queue_name}"
}

# Three quarters of the requests the server's instances take at once
# (server_max_instances x server_concurrency, rounded down), so the rest stays
# free for the API and the console, run streams and the tick. Every task
# counts, /internal/work and /internal/drain too. Each executing run holds its
# request for up to 30 minutes, and nothing else bounds how many execute at
# once: run slots are a tenant's own limits, and a tenant with none has no
# limit. Past the cap a task waits in the queue and spends none of its tries.
# 5000 is Cloud Tasks' own maximum, and so is the rate, which never holds back
# a start below the cap. A task the server couldn't take (a 503, or a 429 with
# every instance full) is tried again for about four minutes. Past that, the
# server's lease sweep sends a kept start again and resumes a run whose lease
# ran out, and a run sent twice runs once. Each task's deadline is the
# server's, per route.
resource "google_cloud_tasks_queue" "runs" {
  count    = local.runs_in_requests ? 1 : 0
  name     = local.runs_queue_name
  location = var.region

  rate_limits {
    max_concurrent_dispatches = min(5000, floor(var.server_max_instances * var.server_concurrency * 3 / 4))
    max_dispatches_per_second = 500
  }

  retry_config {
    max_attempts  = 10
    min_backoff   = "1s"
    max_backoff   = "60s"
    max_doublings = 5
  }

  depends_on = [google_project_service.apis]
}

# The server adds tasks to this queue, and only to it (tasks.create).
resource "google_cloud_tasks_queue_iam_member" "server_enqueues" {
  count    = local.runs_in_requests ? 1 : 0
  name     = google_cloud_tasks_queue.runs[0].name
  location = google_cloud_tasks_queue.runs[0].location
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.server.email}"
}

# A task's token may name an account only if whoever adds the task may act
# as it, and the server names its own. Cloud Tasks' service agent mints the
# token with a role of its own, which Google gives it when the API is turned
# on.
resource "google_service_account_iam_member" "server_acts_as_itself" {
  count              = local.runs_in_requests ? 1 : 0
  service_account_id = google_service_account.server.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.server.email}"
}
