# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The pack orchestrator: `kindgi-runtime packs orchestrate`, from the runtime
# image, as a Cloud Run Job that Cloud Scheduler runs once a minute. Each pass
# makes a Cloud Run service for each deployment that needs one, gives running
# ones their changed pack env, and retires what should go: through the
# server's system routes, and as its own account. The server never makes or
# deletes a service. A deployment waits up to a minute for its service.

locals {
  # The Job and its schedule exist once its key does (orchestrator_key_version).
  orchestrator = var.orchestrator_key_version != null

  # The server behind Cloud Run IAM (neither server_public nor
  # server_invoker_iam_disabled): the Job sends it a Google ID token as well.
  server_iam_guarded = !var.server_public && !var.server_invoker_iam_disabled

  # So the operator's own call that mints the key (orchestrator_key_steps)
  # gets past Cloud Run IAM: their Google ID token, beside the bearer token.
  mint_id_token_header = local.server_iam_guarded ? "\n     -H @<(printf 'X-Serverless-Authorization: Bearer %s\\n' \"$(gcloud auth print-identity-token)\") \\" : ""

  # Secret Manager names its resources by project number. Every secret the
  # orchestrator makes, and so every one a pack service reads, is a kp- one.
  pack_secrets_condition = "resource.name.startsWith(\"projects/${local.project_number}/secrets/kp-\")"

  # How each pack service runs (KINDGI_ORCHESTRATOR_PACK_SERVICE): the pack_*
  # settings, with the connector in connector mode and no network of its own
  # otherwise. 1 vCPU, 1 GiB and a startup boost, the orchestrator's defaults.
  pack_service_settings = merge({
    ingress        = var.pack_ingress == "INGRESS_TRAFFIC_ALL" ? "all" : "internal"
    egress         = var.network_mode == "connector" ? tomap({ kind = "connector", connector = var.vpc_connector }) : tomap({ kind = "none" })
    timeoutSeconds = try(tonumber(trimsuffix(var.pack_timeout, "s")), 0) # pack_timeout's validation names a bad one
    concurrency    = var.pack_concurrency
    maxInstances   = var.pack_max_instances
  }, length(var.pack_cloud_sql_instances) > 0 ? { cloudSqlInstances = var.pack_cloud_sql_instances } : {})
}

# ---- its account ----------------------------------------------------------------

resource "google_service_account" "orchestrator" {
  account_id   = "${var.name_prefix}-orch"
  display_name = "Kindgi pack orchestrator"
  depends_on   = [google_project_service.apis]
}

# Cloud Run: it creates, reads, updates, lists and deletes the project's
# services, and reads a service's policy but never sets one. The role also
# runs the project's Jobs: Cloud Scheduler runs this one as this account.
resource "google_project_iam_member" "orchestrator_runs_services" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.orchestrator.email}"
}

# Each pack service runs as the pack account, and only that one.
resource "google_service_account_iam_member" "orchestrator_acts_as_pack" {
  service_account_id = google_service_account.pack.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.orchestrator.email}"
}

# Cloud Run checks that whoever makes a service, or a new revision of one,
# may read its image: the pack images, in the server's repository.
resource "google_artifact_registry_repository_iam_member" "orchestrator_reads_images" {
  project    = local.own_repository ? null : var.image_repository.project
  repository = local.own_repository ? google_artifact_registry_repository.images[0].name : var.image_repository.repository
  location   = local.own_repository ? var.region : var.image_repository.location
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.orchestrator.email}"
}

# Each pack service's token and secret env values are kp- secrets of its
# own: the orchestrator gets them, adds versions, destroys old ones and
# deletes them. It never reads a value, which comes from the runtime.
resource "google_project_iam_custom_role" "pack_secrets" {
  role_id     = "${replace(var.name_prefix, "-", "_")}_pack_secrets"
  title       = "Kindgi pack secrets"
  description = "The pack orchestrator's rights on the pack services' own secrets (kp-...), never a value."
  permissions = [
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.versions.add",
    "secretmanager.versions.destroy",
    "secretmanager.versions.list",
  ]
}

resource "google_project_iam_member" "orchestrator_pack_secrets" {
  project = var.project_id
  role    = google_project_iam_custom_role.pack_secrets.name
  member  = "serviceAccount:${google_service_account.orchestrator.email}"

  condition {
    title       = "kindgi-pack-secrets-only"
    description = "The pack services' own secrets (kp-...) only."
    expression  = local.pack_secrets_condition
  }
}

# A create and a list name the project as their parent, not one secret, so
# a condition on the secret's name isn't sure to hold for either: a role of
# their own, with no condition. A new secret holds no value until a version
# is added, which only the kp- role allows; a list gives names and labels,
# never a value, to find what a stopped pass left.
resource "google_project_iam_custom_role" "secret_create_list" {
  role_id     = "${replace(var.name_prefix, "-", "_")}_secret_create_list"
  title       = "Kindgi secret create and list"
  description = "Creates secrets, with no value, and lists the project's secrets, names and labels only, for the pack orchestrator."
  permissions = ["secretmanager.secrets.create", "secretmanager.secrets.list"]
}

resource "google_project_iam_member" "orchestrator_creates_lists_secrets" {
  project = var.project_id
  role    = google_project_iam_custom_role.secret_create_list.name
  member  = "serviceAccount:${google_service_account.orchestrator.email}"
}

# Every pack service reads its token and secret env values, kp- secrets all:
# as the one pack account, each may read every one.
resource "google_project_iam_member" "pack_reads_pack_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.pack.email}"

  condition {
    title       = "kindgi-pack-secrets-only"
    description = "The pack services' own secrets (kp-...) only."
    expression  = local.pack_secrets_condition
  }
}

# The secrets a pack's env names as cloud secrets (pack_secret_readers), in
# this project or another: the operator made them, and the pack account reads
# exactly these.
resource "google_secret_manager_secret_iam_member" "pack_reads_cloud_secrets" {
  for_each  = toset([for s in var.pack_secret_readers : "projects/${coalesce(s.project, var.project_id)}/secrets/${s.secret}"])
  secret_id = each.key
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pack.email}"
}

# Its system key (system:deployments and system:pack-env): the operator mints
# it once the server routes per deployment and adds it as a version
# (orchestrator_key_steps). The Job reads the pinned one.
resource "google_secret_manager_secret" "orchestrator_key" {
  secret_id = "${var.name_prefix}-orchestrator-key"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "orchestrator_reads_key" {
  secret_id = google_secret_manager_secret.orchestrator_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.orchestrator.email}"
}

# Behind Cloud Run IAM, the server takes the Job's calls only with a Google
# ID token of an account that may invoke it.
resource "google_cloud_run_v2_service_iam_member" "orchestrator_invokes_server" {
  count    = local.server_iam_guarded ? 1 : 0
  name     = google_cloud_run_v2_service.server.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.orchestrator.email}"
}

# ---- the Job and its schedule ---------------------------------------------------

resource "google_cloud_run_v2_job" "orchestrator" {
  count               = local.orchestrator ? 1 : 0
  name                = "${var.name_prefix}-pack-orchestrator"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.orchestrator.email
      # A backstop: a pass returns by itself before its round ends. No
      # retries: next minute's run is the retry.
      timeout     = "600s"
      max_retries = 0

      containers {
        image = var.server_image
        args  = ["packs", "orchestrate"]

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        env {
          name  = "KINDGI_ORCHESTRATOR_RUNTIME_URL"
          value = google_cloud_run_v2_service.server.uri
        }
        env {
          name = "KINDGI_ORCHESTRATOR_SYSTEM_KEY"
          value_source {
            # Pinned (var.orchestrator_key_version): a version added by
            # mistake never reaches the Job.
            secret_key_ref {
              secret  = google_secret_manager_secret.orchestrator_key.secret_id
              version = var.orchestrator_key_version
            }
          }
        }
        env {
          name  = "KINDGI_ORCHESTRATOR_PROJECT"
          value = var.project_id
        }
        env {
          name  = "KINDGI_ORCHESTRATOR_REGION"
          value = var.region
        }
        env {
          name  = "KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT"
          value = google_service_account.pack.email
        }
        env {
          name  = "KINDGI_ORCHESTRATOR_PACK_SERVICE"
          value = jsonencode(local.pack_service_settings)
        }
        dynamic "env" {
          for_each = local.server_iam_guarded ? ["google-id-token"] : []
          content {
            name  = "KINDGI_ORCHESTRATOR_RUNTIME_AUTH"
            value = env.value
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.orchestrator_reads_key,
    google_project_iam_member.orchestrator_runs_services,
    google_service_account_iam_member.orchestrator_acts_as_pack,
    google_artifact_registry_repository_iam_member.orchestrator_reads_images,
    google_project_iam_member.orchestrator_pack_secrets,
    google_project_iam_member.orchestrator_creates_lists_secrets,
    google_project_iam_member.pack_reads_pack_secrets,
    google_cloud_run_v2_service_iam_member.orchestrator_invokes_server,
  ]
}

# Once a minute. A pass holds the server's round, so one that starts while
# another runs exits doing nothing. One attempt: next minute's is the retry.
resource "google_cloud_scheduler_job" "orchestrator" {
  count     = local.orchestrator ? 1 : 0
  name      = "${var.name_prefix}-pack-orchestrator"
  region    = var.region
  schedule  = "* * * * *"
  time_zone = "Etc/UTC"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.orchestrator[0].name}:run"

    oauth_token {
      service_account_email = google_service_account.orchestrator.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_project_service.apis]
}
