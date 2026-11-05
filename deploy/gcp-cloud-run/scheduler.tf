# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The server's tick, with server_billing = "request". There the server has
# CPU only while a request is in flight, so its timers don't run between
# requests. Cloud Scheduler calls POST /internal/tick once a minute instead,
# with a Google-signed ID token of an account of its own. Each call runs the
# server's background work that's due (schedules, mail polls, webhook
# deliveries and more; the docs' Cloud Run page, "Scale the server to zero",
# lists it all) inside the request. The server checks the token
# itself: its audience is the tick's URL and its email is this account's
# (KINDGI_TICK_CALLER), since Cloud Run IAM guards a whole service, not one
# route.

locals {
  server_tick = var.server_billing == "request"

  # The server's own address, Cloud Run's deterministic run.app URL: the
  # server's env can't name its own resource's uri.
  server_service_url = "https://${var.name_prefix}-server-${local.project_number}.${var.region}.run.app"
  tick_url           = "${local.server_service_url}/internal/tick"
}

# Only Cloud Scheduler signs as it: it's granted nothing, and the server
# takes its token on the tick alone.
resource "google_service_account" "tick" {
  count        = local.server_tick ? 1 : 0
  account_id   = "${var.name_prefix}-tick"
  display_name = "Kindgi server tick (Cloud Scheduler)"
  depends_on   = [google_project_service.apis]
}

# Once a minute. A tick while one runs answers at once, doing nothing, and a
# loop's turn is claimed in the database, so two never run it twice. No
# retry: next minute's tick is the retry. The deadline is Cloud Scheduler's
# longest, so a long pass keeps its request, and so its CPU.
resource "google_cloud_scheduler_job" "tick" {
  count            = local.server_tick ? 1 : 0
  name             = "${var.name_prefix}-server-tick"
  region           = var.region
  schedule         = "* * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "1800s"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = local.tick_url

    oidc_token {
      service_account_email = google_service_account.tick[0].email
      audience              = local.tick_url
    }
  }

  depends_on = [google_project_service.apis, google_cloud_run_v2_service.server]
}
