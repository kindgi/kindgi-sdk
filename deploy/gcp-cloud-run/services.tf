# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The two Cloud Run services: the pack service (runs the pack's code,
# internal only) and the server (the API, agent and flow execution).

locals {
  sql_connection = google_sql_database_instance.kindgi.connection_name
  registry_host  = "${var.region}-docker.pkg.dev"
}

# ---- the pack service ---------------------------------------------------------

resource "google_cloud_run_v2_service" "pack" {
  name                = "${var.name_prefix}-pack"
  location            = var.region
  ingress             = var.pack_ingress
  deletion_protection = false

  template {
    service_account                  = google_service_account.pack.email
    timeout                          = var.pack_timeout
    max_instance_request_concurrency = var.pack_concurrency

    scaling {
      min_instance_count = var.pack_min_instances
      max_instance_count = var.pack_max_instances
    }

    # Connector mode: the pack's code reaches private IPs (an app
    # database) through the existing connector.
    dynamic "vpc_access" {
      for_each = local.direct ? [] : [1]
      content {
        connector = var.vpc_connector
        egress    = "PRIVATE_RANGES_ONLY"
      }
    }

    dynamic "volumes" {
      for_each = length(var.pack_cloud_sql_instances) > 0 ? [1] : []
      content {
        name = "cloudsql"
        cloud_sql_instance {
          instances = var.pack_cloud_sql_instances
        }
      }
    }

    containers {
      image = var.pack_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      env {
        name = "KINDGI_PACK_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.shared["pack_service_token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "KINDGI_PACK_SERVICE_MAX_CONCURRENCY"
        value = tostring(var.pack_concurrency)
      }
      env {
        name  = "KINDGI_PACK_ENV_CHECK"
        value = "strict"
      }

      # The pack's declared env (`kindgi env plan --env <name>`): plain
      # values, then Secret Manager references, read with this service's
      # identity at instance start.
      dynamic "env" {
        for_each = var.pack_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.pack_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.project == null ? env.value.secret : "projects/${env.value.project}/secrets/${env.value.secret}"
              version = env.value.version
            }
          }
        }
      }

      dynamic "volume_mounts" {
        for_each = length(var.pack_cloud_sql_instances) > 0 ? [1] : []
        content {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      # Not ready until every module is loaded and every env.required name
      # is set: a revision missing one never takes traffic, and its logs
      # (and /v1/info) name what's missing.
      startup_probe {
        http_get {
          path = "/readyz"
          port = 8080
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 24
      }
      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds = 30
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.pack_reads_token,
  ]
}

# Only the server may call the pack service (with a Google ID token, plus
# the pack token in Kindgi-Pack-Token).
resource "google_cloud_run_v2_service_iam_member" "server_invokes_pack" {
  name     = google_cloud_run_v2_service.pack.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.server.email}"
}

# ---- the server ---------------------------------------------------------------

resource "google_cloud_run_v2_service" "server" {
  name                 = "${var.name_prefix}-server"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  deletion_protection  = false
  invoker_iam_disabled = var.server_invoker_iam_disabled

  template {
    service_account = google_service_account.server.email
    timeout         = "3600s"
    # The second-generation environment. The two keys come as env vars
    # (base64, from Secret Manager), not as files: a secret volume is 0444
    # and, in gen2, root's, and the server refuses a key file others can read.
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = var.server_min_instances
      max_instance_count = var.server_max_instances
    }

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

    # Connector mode: Kindgi's private-IP database through the existing
    # connector; everything else leaves through Cloud Run's own egress.
    # With the /cloudsql socket the server needs no VPC at all.
    dynamic "vpc_access" {
      for_each = !local.direct && local.database_private ? [1] : []
      content {
        connector = var.vpc_connector
        egress    = "PRIVATE_RANGES_ONLY"
      }
    }

    # The Cloud SQL connector's socket, unless the database is private-IP
    # only (then the server connects over TCP).
    dynamic "volumes" {
      for_each = local.database_private ? [] : [1]
      content {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.sql_connection]
        }
      }
    }

    containers {
      image = var.server_image

      ports {
        container_port = 4000
      }

      resources {
        limits = {
          cpu    = var.server_cpu
          memory = var.server_memory
        }
        # CPU stays allocated between requests: a run started with
        # wait:false keeps executing after its 202.
        cpu_idle          = false
        startup_cpu_boost = true
      }

      dynamic "volume_mounts" {
        for_each = local.database_private ? [] : [1]
        content {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      env {
        name  = "KINDGI_ENV"
        value = var.kindgi_env
      }
      dynamic "env" {
        for_each = var.pack_call_timeout_ms == null ? [] : [var.pack_call_timeout_ms]
        content {
          name  = "KINDGI_PACK_CALL_TIMEOUT_MS"
          value = tostring(env.value)
        }
      }
      env {
        name = "KINDGI_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.server["database_url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "KINDGI_TENANT_ID"
        value = var.seed_tenant_id
      }
      env {
        name  = "KINDGI_SEED_USER_ID"
        value = var.seed_user_id
      }
      env {
        name = "KINDGI_API_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.server["api_token"].secret_id
            version = "latest"
          }
        }
      }

      # Secrets set through the API (secrets_backend = "postgres"):
      # envelope-encrypted in Postgres under the KMS key. With "none", no
      # KINDGI_SECRETS_* variable is set: the runtime stores no secrets.
      # The order is the one these had before secrets_backend existed.
      dynamic "env" {
        for_each = local.kms ? [["KINDGI_SECRETS_BACKEND", "postgres"], ["KINDGI_SECRETS_BACKEND_KMS", "gcp"]] : []
        content {
          name  = env.value[0]
          value = env.value[1]
        }
      }
      dynamic "env" {
        for_each = local.kms ? [1] : []
        content {
          name = "KINDGI_SECRETS_AAD_KEY"
          value_source {
            # Pinned (var.secrets_aad_key_version): every secret stored in
            # Postgres is bound to this key, so a version added by mistake
            # must never reach the server.
            secret_key_ref {
              secret  = google_secret_manager_secret.server["secrets_aad_key"].secret_id
              version = var.secrets_aad_key_version
            }
          }
        }
      }
      dynamic "env" {
        for_each = local.kms ? [
          ["KINDGI_SECRETS_GCP_PROJECT_ID", var.project_id],
          ["KINDGI_SECRETS_GCP_LOCATION_ID", var.region],
          ["KINDGI_SECRETS_GCP_KEY_RING_ID", google_kms_key_ring.kindgi[0].name],
          ["KINDGI_SECRETS_GCP_KEY_ID", google_kms_crypto_key.secrets[0].name],
        ] : []
        content {
          name  = env.value[0]
          value = env.value[1]
        }
      }

      # The pack service: its internal URL, the shared token, and a Google
      # ID token per call (KINDGI_PACK_SERVICE_AUTH).
      env {
        name  = "KINDGI_PACK_SERVICE_URL"
        value = google_cloud_run_v2_service.pack.uri
      }
      env {
        name = "KINDGI_PACK_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.shared["pack_service_token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "KINDGI_PACK_SERVICE_AUTH"
        value = "google-id-token"
      }

      # Reading deployments' images from Artifact Registry with the
      # service's own identity (KINDGI_IMAGE_REGISTRY_AUTH).
      env {
        name  = "KINDGI_IMAGE_REGISTRY_HOST"
        value = local.registry_host
      }
      env {
        name  = "KINDGI_IMAGE_REGISTRY_AUTH"
        value = "google"
      }

      # The license key: outside dev mode the server won't start without
      # a valid one. Checked offline; a secret like the keys above.
      env {
        name = "KINDGI_LICENSE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.server["license_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "KINDGI_PUBLIC_TOKEN_SIGNING_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.server["public_token_key"].secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = length(var.cors_origins) > 0 ? [join(",", var.cors_origins)] : []
        content {
          name  = "KINDGI_CORS_ORIGINS"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.openfga_api_url != "" ? [var.openfga_api_url] : []
        content {
          name  = "KINDGI_OPENFGA_API_URL"
          value = env.value
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 4000
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 24
      }
      liveness_probe {
        http_get {
          path = "/health"
          port = 4000
        }
        period_seconds = 30
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.network_mode == "direct" || var.vpc_connector != ""
      error_message = "network_mode = \"connector\" needs vpc_connector (projects/<project>/locations/<region>/connectors/<name>)."
    }
    precondition {
      condition     = var.network_mode == "direct" || var.pack_ingress == "INGRESS_TRAFFIC_ALL"
      error_message = "network_mode = \"connector\" needs pack_ingress = \"INGRESS_TRAFFIC_ALL\": a private-ranges-only server can't reach an internal-only pack service (IAM still guards it)."
    }
    precondition {
      condition     = !local.kms || var.secrets_aad_key_version != null
      error_message = "secrets_backend = \"postgres\" needs secrets_aad_key_version: the version of <prefix>-secrets-aad-key the server reads (\"1\" for a new deployment), never \"latest\"."
    }
    precondition {
      condition     = !(var.server_public && var.server_invoker_iam_disabled)
      error_message = "server_public (an allUsers invoker binding) and server_invoker_iam_disabled are two ways to the same thing: pick one."
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.server_reads,
    google_kms_crypto_key_iam_member.server_wraps,
    google_kms_crypto_key_iam_member.server_reads_key,
    google_project_iam_member.server_sql_client,
    google_compute_router_nat.nat,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "server_public" {
  count    = var.server_public ? 1 : 0
  name     = google_cloud_run_v2_service.server.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
