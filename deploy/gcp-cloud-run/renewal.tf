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
# starts it. The server takes a renewed key at its next start; the job
# never restarts it (the runtime checks its key at startup only).

locals {
  renewal                = var.license_renewal_schedule != ""
  license_renewer_secret = var.license_renewer_secret != "" ? var.license_renewer_secret : "${var.name_prefix}-license-renewer"
  # Where `kindgi license renew` and `enroll` find each secret.
  license_key_ref     = "gcp:projects/${var.project_id}/secrets/${local.server_secrets["license_key"]}"
  license_renewer_ref = "gcp:projects/${var.project_id}/secrets/${local.license_renewer_secret}"
  renewal_job         = "${var.name_prefix}-license-renewal"
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
}

# ---- the scheduled renewal (opt-in: var.license_renewal_schedule) -------------

resource "google_service_account" "license_renewer" {
  count        = local.renewal ? 1 : 0
  account_id   = "${var.name_prefix}-renew"
  display_name = "Kindgi license renewal"
  depends_on   = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "renewer_reads" {
  for_each = local.renewal ? {
    license_key = google_secret_manager_secret.server["license_key"].id
    renewer     = google_secret_manager_secret.license_renewer.id
  } : {}
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.license_renewer[0].email}"
}

# It writes the renewed key as a new version; it can't change or delete one.
resource "google_secret_manager_secret_iam_member" "renewer_adds_key_versions" {
  count     = local.renewal ? 1 : 0
  secret_id = google_secret_manager_secret.server["license_key"].id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.license_renewer[0].email}"
}

resource "google_cloud_run_v2_job" "license_renewal" {
  count               = local.renewal ? 1 : 0
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
      # egress address to allow); in `connector` through Cloud Run's own.
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
        args    = ["license", "renew", "--key", local.license_key_ref, "--renewer", local.license_renewer_ref]
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
  count    = local.renewal ? 1 : 0
  name     = google_cloud_run_v2_job.license_renewal[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.license_renewer[0].email}"
}

resource "google_cloud_scheduler_job" "license_renewal" {
  count     = local.renewal ? 1 : 0
  name      = local.renewal_job
  region    = var.license_renewal_scheduler_region != "" ? var.license_renewal_scheduler_region : var.region
  schedule  = var.license_renewal_schedule
  time_zone = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.license_renewal[0].name}:run"
    oauth_token {
      service_account_email = google_service_account.license_renewer[0].email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.renewer_runs_renewal]
}

# ---- alerts (with the schedule) -------------------------------------------------

resource "google_monitoring_alert_policy" "license_renewal_failed" {
  count        = local.renewal ? 1 : 0
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

# `kindgi license renew` prints "⚠ It expires in <days> days" in a key's
# last 30 days. Fewer than 7 left: renewals aren't bringing a new key.
resource "google_monitoring_alert_policy" "license_key_expiring" {
  count        = local.renewal ? 1 : 0
  display_name = "${var.name_prefix}: license key expires within 7 days"
  combiner     = "OR"

  conditions {
    display_name = "${local.renewal_job} reports under 7 days left"
    condition_matched_log {
      filter = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"${local.renewal_job}\" AND textPayload =~ \"It expires in (-[0-9]+|[0-6]) days\""
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
    content   = "The license key expires within 7 days and renewals answer `unchanged`. A self-serve key: sign in at access.kindgi.com for a new one. A production key: write to contact@kindgi.com to extend the term."
  }

  depends_on = [google_project_service.apis]
}
