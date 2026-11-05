# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The license key's renewal. It's something the operator runs: by hand
# (`kindgi license renew`), or on a schedule this module adds when
# license_renewal_schedule is set. Nothing calls Kindgi otherwise.
#
# Either way:
# - <prefix>-license-renewer holds the deployment's renewer key. The module
#   creates it empty; `kindgi license enroll` adds it once (README, step 8).
#   The server never reads it.
# - The server gets KINDGI_LICENSE_KEY_REF and KINDGI_LICENSE_RENEWER_REF,
#   so its expiry warning names the exact renew command.
#
# With a schedule: a Cloud Run job on the runtime image runs
# `kindgi license renew` as a service account of its own, which may read
# both secrets and add versions to the license key only. Cloud Scheduler
# starts it. The job never restarts the server.
#
# With license_usage_key_secret too, the job renews with --runtime (the
# server's run.app URL) and --runtime-token (a system key holding
# system:license alone, which the operator mints and keeps in that secret).
# It then sends counts of the deployment's use, and from runtime 0.7.0 it
# hands a renewed key to the running server, which uses it at once. Without
# it, the server takes a renewed key at its next start. The schedule turns
# on Cloud Monitoring's API too, for the alerts below (foundation.tf).

locals {
  license_renewal        = var.license_renewal_schedule != ""
  license_renewer_secret = var.license_renewer_secret != "" ? var.license_renewer_secret : "${var.name_prefix}-license-renewer"
  license_usage_counts   = var.license_usage_key_secret != ""

  # Where `kindgi license renew` and `enroll` find each secret.
  license_key_ref     = "gcp:projects/${var.project_id}/secrets/${local.server_secrets["license_key"]}"
  license_renewer_ref = "gcp:projects/${var.project_id}/secrets/${local.license_renewer_secret}"
  renewal_job         = "${var.name_prefix}-license-renewal"

  # `kindgi license renew`'s arguments: with the usage key, the server and
  # the secret its system key is in, for the counts and the key's hand-over.
  license_renew_args = concat(
    ["license", "renew", "--key", local.license_key_ref, "--renewer", local.license_renewer_ref],
    local.license_usage_counts ? [
      "--runtime", google_cloud_run_v2_service.server.uri,
      "--runtime-token", "gcp:projects/${var.project_id}/secrets/${var.license_usage_key_secret}",
    ] : [],
  )
}

resource "google_secret_manager_secret" "license_renewer" {
  secret_id = local.license_renewer_secret

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.apis]

  lifecycle {
    # The job sends the usage key as a Kindgi bearer, and nothing else. Behind
    # Cloud Run IAM, Cloud Run refuses a call without a Google ID token before
    # the server sees it, so the counts and the key's hand-over would both be
    # refused on every run.
    precondition {
      condition     = !local.license_usage_counts || !local.server_iam_guarded
      error_message = "license_usage_key_secret needs a server that takes calls without Cloud Run IAM: the renewal job sends the server only its system key, as a Kindgi bearer, and with server_public = false and server_invoker_iam_disabled = false Cloud Run refuses a call without a Google ID token before the server sees it. Set server_invoker_iam_disabled = true (the API still requires its bearer token) or server_public = true, or leave license_usage_key_secret empty: the key then renews without counts, and the server takes it at its next start."
    }
  }
}

# ---- the scheduled renewal (opt-in: var.license_renewal_schedule) -------------

resource "google_service_account" "license_renewer" {
  count        = local.license_renewal ? 1 : 0
  account_id   = "${var.name_prefix}-renew"
  display_name = "Kindgi license renewal"
  depends_on   = [google_project_service.apis]
}

# Reading: the license key (to check a new one is for the same holder and
# newer), the renewer key (to sign its request) and, with
# license_usage_key_secret, the usage key (for the counts and the hand-over).
# The usage key's secret is the operator's, made before this apply (README,
# step 8).
resource "google_secret_manager_secret_iam_member" "renewer_reads" {
  for_each = local.license_renewal ? merge({
    license_key = google_secret_manager_secret.server["license_key"].id
    renewer     = google_secret_manager_secret.license_renewer.id
  }, local.license_usage_counts ? { usage_key = "projects/${var.project_id}/secrets/${var.license_usage_key_secret}" } : {}) : {}
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.license_renewer[0].email}"
}

# It writes the renewed key as a new version; it can't change or delete one.
resource "google_secret_manager_secret_iam_member" "renewer_adds_key_versions" {
  count     = local.license_renewal ? 1 : 0
  secret_id = google_secret_manager_secret.server["license_key"].id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.license_renewer[0].email}"
}

resource "google_cloud_run_v2_job" "license_renewal" {
  count               = local.license_renewal ? 1 : 0
  name                = local.renewal_job
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.license_renewer[0].email
      timeout         = "300s"
      # A retry asks again with a new nonce: safe.
      max_retries = 1

      # In `direct` the job leaves like the server, through Cloud NAT (one
      # egress address to allow), and reaches the server's run.app URL
      # through the VPC, behind your load balancer too (server_ingress). In
      # `connector` and `none`, through Cloud Run's own egress.
      dynamic "vpc_access" {
        for_each = local.direct ? [1] : []
        content {
          network_interfaces {
            network    = google_compute_network.kindgi[0].id
            subnetwork = google_compute_subnetwork.run[0].id
          }
          egress = "ALL_TRAFFIC"
        }
      }

      containers {
        image   = var.server_image
        command = ["kindgi"]
        args    = local.license_renew_args
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.renewer_reads,
    google_secret_manager_secret_iam_member.renewer_adds_key_versions,
  ]
}

# Cloud Scheduler starts the job as the job's own service account.
resource "google_cloud_run_v2_job_iam_member" "renewer_runs_renewal" {
  count    = local.license_renewal ? 1 : 0
  name     = google_cloud_run_v2_job.license_renewal[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.license_renewer[0].email}"
}

resource "google_cloud_scheduler_job" "license_renewal" {
  count     = local.license_renewal ? 1 : 0
  name      = local.renewal_job
  region    = var.license_renewal_scheduler_region != "" ? var.license_renewal_scheduler_region : var.region
  schedule  = var.license_renewal_schedule
  time_zone = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.license_renewal[0].name}:run"
    oauth_token {
      service_account_email = google_service_account.license_renewer[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_project_service.apis, google_cloud_run_v2_job_iam_member.renewer_runs_renewal]
}

# ---- alerts (with the schedule) -------------------------------------------------
# Sent to alert_notification_channels (none: they open incidents in the
# console only): a renewal that failed, a key inside its warning window,
# which `kindgi license renew` says on every run ("⚠ It expires in N
# days"), and, with the usage key, a run that sent no counts ("counts: not
# sent (<why>)"). The CLI's tests run renew against these filters
# (packages/cli/tests/license-commands.test.ts).

resource "google_monitoring_alert_policy" "license_renewal_failed" {
  count        = local.license_renewal ? 1 : 0
  display_name = "${var.name_prefix}: license renewal failed"
  combiner     = "OR"

  conditions {
    display_name = "A run of ${local.renewal_job} failed"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"${local.renewal_job}\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "900s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = var.alert_notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = "`kindgi license renew` failed or was refused in the job `${local.renewal_job}`. Its log has one line saying why (`refused (<reason>): …` or the failure). The key in use keeps working until its own date."
  }

  depends_on = [google_project_service.apis]
}

# `kindgi license renew` prints "⚠ It expires in <days> days" while the key
# is inside its warning window: 30 days before it expires, or fewer when the
# key sets its own. Any such line: renewals aren't bringing a new key.
resource "google_monitoring_alert_policy" "license_key_expiring" {
  count        = local.license_renewal ? 1 : 0
  display_name = "${var.name_prefix}: license key inside its warning window"
  combiner     = "OR"

  conditions {
    display_name = "${local.renewal_job} reports the key expiring"
    condition_matched_log {
      filter = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"${local.renewal_job}\" AND textPayload =~ \"It expires in -?[0-9]+ days\""
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
  }

  notification_channels = var.alert_notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = "The license key is inside its warning window, and renewing hasn't brought one that lasts longer. The run's line `⚠ It expires in <days> days. …` says how long the key has and what to do next. The key in use keeps working until its own date."
  }

  depends_on = [google_project_service.apis]
}

# The renewal went on without the counts: the usage key expired or was
# revoked, or the job can't reach the server, say. A run that renews without
# them still succeeds, so the failed-run alert never sees it. A production
# key's renewal carries no counts by design, and says so with a reason of
# its own, which this leaves out.
resource "google_monitoring_alert_policy" "license_counts_not_sent" {
  count        = local.license_renewal && local.license_usage_counts ? 1 : 0
  display_name = "${var.name_prefix}: license renewal sent no counts"
  combiner     = "OR"

  conditions {
    display_name = "${local.renewal_job} reports counts not sent"
    condition_matched_log {
      filter = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"${local.renewal_job}\" AND textPayload =~ \"counts: not sent [(]\" AND NOT textPayload =~ \"counts: not sent [(]a production key's renewal carries no counts[)]\""
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
  }

  notification_channels = var.alert_notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = "The license renewal ran without sending this deployment's counts: see the job `${local.renewal_job}`'s last run for its line `counts: not sent (<why>)`. Usually the system key in the secret ${var.license_usage_key_secret} has expired or been revoked, or the job can't reach the server. The key still renews without them, and a run that failed raises its own alert too."
  }

  depends_on = [google_project_service.apis]
}
