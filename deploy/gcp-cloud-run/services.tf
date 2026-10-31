# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The server (the API, agent and flow execution) on Cloud Run. Each
# deployment's pack code runs in a Cloud Run service of its own, which the
# pack orchestrator makes (orchestrator.tf); the server calls each one at the
# endpoint it recorded (KINDGI_PACK_ROUTING=per-deployment).

locals {
  # The instance the server serves from: database_instance's (a restore
  # pointer), else database_host_instance's (a shared instance), else the
  # module's own.
  sql_connection = (
    var.database_instance != null ? data.google_sql_database_instance.served[0].connection_name :
    var.database_host_instance != null ? data.google_sql_database_instance.host[0].connection_name :
    google_sql_database_instance.kindgi[0].connection_name
  )
  database_url_secret = (var.database_instance == null
    ? google_secret_manager_secret.server["database_url"].secret_id
  : var.database_instance.url_secret)
  registry_host = "${local.own_repository ? var.region : var.image_repository.location}-docker.pkg.dev"

  # Every name the module sets on the server (some only with an option on),
  # plus KINDGI_DEV and KINDGI_DATABASE_SERVER_CA_PATH (the database's CA
  # comes from the module): server_env and server_secret_env can't set these.
  # KINDGI_PUBLIC_URL comes from var.public_url.
  server_module_env = toset([
    "KINDGI_API_TOKEN", "KINDGI_CORS_ORIGINS", "KINDGI_DATABASE_SERVER_CA",
    "KINDGI_DATABASE_SERVER_CA_PATH", "KINDGI_DATABASE_URL", "KINDGI_DEV", "KINDGI_ENV",
    "KINDGI_EXPORT_SIGNING_KEY", "KINDGI_EXPORT_SIGNING_KMS_KEY", "KINDGI_IMAGE_REGISTRY_AUTH",
    "KINDGI_IMAGE_REGISTRY_HOST", "KINDGI_LICENSE_KEY", "KINDGI_OPENFGA_API_URL",
    "KINDGI_PACK_CALL_TIMEOUT_MS", "KINDGI_PACK_ENDPOINT_HOSTS", "KINDGI_PACK_ENDPOINT_KMS_KEY",
    "KINDGI_PACK_ROUTING", "KINDGI_PUBLIC_TOKEN_SIGNING_KEY", "KINDGI_PUBLIC_URL",
    "KINDGI_SECRETS_AAD_KEY", "KINDGI_SECRETS_BACKEND", "KINDGI_SECRETS_BACKEND_KMS",
    "KINDGI_SECRETS_GCP_KEY_ID", "KINDGI_SECRETS_GCP_KEY_RING_ID", "KINDGI_SECRETS_GCP_LOCATION_ID",
    "KINDGI_SECRETS_GCP_PROJECT_ID", "KINDGI_SEED_USER_ID", "KINDGI_TENANCY", "KINDGI_TENANT_ID",
    "KINDGI_TRUSTED_PROXIES",
  ])
  server_extra_env = setunion(keys(var.server_env), keys(var.server_secret_env))
  # The one pack service's settings, which a server routing per deployment
  # refuses at boot: each endpoint carries its own URL, token and auth.
  single_pack_env = toset(["KINDGI_PACK_SERVICE_AUTH", "KINDGI_PACK_SERVICE_TOKEN", "KINDGI_PACK_SERVICE_URL"])

  # Where the pack orchestrator makes each deployment's service: Cloud Run's
  # deterministic URLs in this project and region, the only hosts the server
  # takes an endpoint on.
  pack_endpoint_hosts = "*-${local.project_number}.${var.region}.run.app"

  # What a server serving many tenants needs, each named when it's missing.
  multi_missing = compact([
    var.openfga_api_url == "" ? "openfga_api_url (without an authorization store, no tenant would have an admin)" : "",
    contains(keys(var.server_secret_env), "KINDGI_OPENFGA_PRESHARED_KEY") ? "" : "server_secret_env's KINDGI_OPENFGA_PRESHARED_KEY (a key the authorization store accepts)",
    lookup(var.server_env, "KINDGI_TENANT_HOST_ACCESS", "") == "isolated" ? "" : "server_env's KINDGI_TENANT_HOST_ACCESS = \"isolated\"",
  ])
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
      for_each = var.network_mode == "connector" && local.database_private ? [1] : []
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
      # The client's address, for rate limits and audit records: Cloud Run's
      # front end appends the client to X-Forwarded-For (measured live), so
      # one trusted hop by default.
      dynamic "env" {
        for_each = var.trusted_proxies == "" ? [] : [var.trusted_proxies]
        content {
          name  = "KINDGI_TRUSTED_PROXIES"
          value = env.value
        }
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
            secret  = local.database_url_secret
            version = "latest"
          }
        }
      }
      # Private-IP mode: the instance's CAs, which the database's
      # certificate must chain to (data.tf). The /cloudsql socket is the
      # connector's, which checks the instance itself.
      dynamic "env" {
        for_each = local.database_private ? [local.database_server_ca] : []
        content {
          name  = "KINDGI_DATABASE_SERVER_CA"
          value = env.value
        }
      }
      # The tenant: with "single", the one the server seeds and serves, and
      # the user its API token acts as; with "multi", neither, since each
      # request's tenant comes from its key or session. "single" sets no
      # KINDGI_TENANCY, so its env is the same as before tenancy existed.
      dynamic "env" {
        for_each = var.tenancy == "single" ? [
          ["KINDGI_TENANT_ID", var.seed_tenant_id],
          ["KINDGI_SEED_USER_ID", var.seed_user_id],
        ] : [["KINDGI_TENANCY", "multi"]]
        content {
          name  = env.value[0]
          value = env.value[1]
        }
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
        for_each = local.postgres_secrets ? [["KINDGI_SECRETS_BACKEND", "postgres"], ["KINDGI_SECRETS_BACKEND_KMS", "gcp"]] : []
        content {
          name  = env.value[0]
          value = env.value[1]
        }
      }
      dynamic "env" {
        for_each = local.postgres_secrets ? [1] : []
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
        for_each = local.postgres_secrets ? [
          ["KINDGI_SECRETS_GCP_PROJECT_ID", var.project_id],
          ["KINDGI_SECRETS_GCP_LOCATION_ID", var.region],
          ["KINDGI_SECRETS_GCP_KEY_RING_ID", google_kms_key_ring.kindgi.name],
          ["KINDGI_SECRETS_GCP_KEY_ID", google_kms_crypto_key.secrets.name],
        ] : []
        content {
          name  = env.value[0]
          value = env.value[1]
        }
      }

      # Each call goes to the pack service of the deployment that shipped
      # what it names, at the endpoint the pack orchestrator recorded: a
      # Cloud Run URL of this project and region, called with a Google ID
      # token and that service's own token. Each endpoint's token is sealed
      # under the module's key (KINDGI_PACK_ENDPOINT_KMS_KEY), whatever the
      # secrets backend: turning the store on later changes nothing for them.
      env {
        name  = "KINDGI_PACK_ROUTING"
        value = "per-deployment"
      }
      env {
        name  = "KINDGI_PACK_ENDPOINT_HOSTS"
        value = local.pack_endpoint_hosts
      }
      env {
        name  = "KINDGI_PACK_ENDPOINT_KMS_KEY"
        value = google_kms_crypto_key.secrets.id
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
        for_each = google_secret_manager_secret.export_signing_key[*].secret_id
        content {
          name = "KINDGI_EXPORT_SIGNING_KEY"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.export_signing == "kms" ? [var.export_signing_kms_key] : []
        content {
          name  = "KINDGI_EXPORT_SIGNING_KMS_KEY"
          value = env.value
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
      dynamic "env" {
        for_each = var.public_url != "" ? [var.public_url] : []
        content {
          name  = "KINDGI_PUBLIC_URL"
          value = env.value
        }
      }

      # The operator's own settings (sign-in, among others): plain values,
      # then Secret Manager references, read with the server's identity at
      # instance start.
      dynamic "env" {
        for_each = var.server_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.server_secret_env
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
      condition     = var.network_mode != "connector" || var.vpc_connector != ""
      error_message = "network_mode = \"connector\" needs vpc_connector (projects/<project>/locations/<region>/connectors/<name>)."
    }
    precondition {
      condition     = var.network_mode == "direct" || var.pack_ingress == "INGRESS_TRAFFIC_ALL"
      error_message = "network_mode = \"connector\" or \"none\" needs pack_ingress = \"INGRESS_TRAFFIC_ALL\": a server without a VPC reaches each pack service over its public URL (IAM still admits only the project's invokers, the server's account among them)."
    }
    precondition {
      condition     = length(setintersection(local.single_pack_env, local.server_extra_env)) == 0
      error_message = "server_env and server_secret_env can't set KINDGI_PACK_SERVICE_URL, KINDGI_PACK_SERVICE_TOKEN or KINDGI_PACK_SERVICE_AUTH: the server calls each deployment's own pack service, whose endpoint carries its own URL, token and auth, and refuses the one pack service's settings."
    }
    precondition {
      condition     = !local.postgres_secrets || var.secrets_aad_key_version != null
      error_message = "secrets_backend = \"postgres\" needs secrets_aad_key_version: the version of <prefix>-secrets-aad-key the server reads (\"1\" for a new deployment), never \"latest\"."
    }
    precondition {
      condition     = var.export_signing != "kms" || var.export_signing_kms_key != ""
      error_message = "export_signing = \"kms\" needs export_signing_kms_key: the key version that signs."
    }
    precondition {
      condition     = var.database_instance == null || var.database_private_network == ""
      error_message = "database_instance serves from another instance through the /cloudsql volume, which private-IP mode (database_private_network) doesn't use: unset one."
    }
    precondition {
      condition     = try(var.database_instance.name != var.name_prefix, true)
      error_message = "database_instance names the module's own instance (${var.name_prefix}): leave database_instance null to serve from it."
    }
    precondition {
      condition     = try(var.database_instance.url_secret != local.server_secrets.database_url, true)
      error_message = "database_instance.url_secret is the module's own ${local.server_secrets.database_url}, whose URL names the module's own instance: put the other instance's URL in a secret of its own."
    }
    precondition {
      condition     = var.database_host_instance == null || var.database_private_network == ""
      error_message = "database_host_instance reaches the shared instance through the /cloudsql volume, which private-IP mode (database_private_network) doesn't use: unset one."
    }
    precondition {
      condition     = try(var.database_host_instance != var.name_prefix, true)
      error_message = "database_host_instance (${var.name_prefix}) names what the module's own instance would be called: the host is a separate, existing instance, so give its own name or leave database_host_instance null."
    }
    precondition {
      condition     = try(var.database_instance.name != var.database_host_instance, true)
      error_message = "database_instance (the instance the server serves from) names database_host_instance, where Kindgi's database already lives: serve from a clone of it, not from itself."
    }
    precondition {
      condition     = var.database_private_network == "" || var.network_mode != "none"
      error_message = "network_mode = \"none\" creates no VPC: a private-IP database (database_private_network) needs \"direct\" or \"connector\"."
    }
    precondition {
      condition     = var.network_mode != "none" || !var.nat_static_ip
      error_message = "network_mode = \"none\" creates no Cloud NAT, so nat_static_ip has nothing to reserve; it applies in \"direct\" and is ignored in \"connector\"."
    }
    precondition {
      condition     = var.network_mode != "direct" || var.nat_max_ports_per_vm > var.nat_min_ports_per_vm
      error_message = "nat_max_ports_per_vm must be above nat_min_ports_per_vm: the Cloud NAT doubles an instance's ports from the minimum up to the maximum."
    }
    precondition {
      condition     = !(var.server_public && var.server_invoker_iam_disabled)
      error_message = "server_public (an allUsers invoker binding) and server_invoker_iam_disabled are two ways to the same thing: pick one."
    }
    precondition {
      condition     = length(setintersection(local.server_module_env, local.server_extra_env)) == 0
      error_message = "server_env and server_secret_env can't set a name this module sets itself (its variables do: public_url for KINDGI_PUBLIC_URL, trusted_proxies, cors_origins, ...), nor KINDGI_DEV, which is for `kindgi dev` only."
    }
    precondition {
      condition     = length(setintersection(keys(var.server_env), keys(var.server_secret_env))) == 0
      error_message = "A name is in both server_env and server_secret_env: keep it in one."
    }
    precondition {
      condition     = var.tenancy != "single" || (var.seed_tenant_id != null && var.seed_user_id != null)
      error_message = "tenancy = \"single\" needs seed_tenant_id and seed_user_id: the tenant the server seeds and serves, and the user its API token acts as."
    }
    precondition {
      condition     = var.tenancy != "multi" || (var.seed_tenant_id == null && var.seed_user_id == null)
      error_message = "tenancy = \"multi\" takes no seed_tenant_id or seed_user_id: a server serving many tenants takes each request's tenant from its key or session, and refuses KINDGI_TENANT_ID and KINDGI_SEED_USER_ID. Leave both unset."
    }
    precondition {
      condition     = var.tenancy != "multi" || length(local.multi_missing) == 0
      error_message = "tenancy = \"multi\" needs: ${join("; ", local.multi_missing)}. The server won't start without them."
    }
    precondition {
      condition     = length(setintersection(local.server_extra_env, toset(["KINDGI_AUTH_SECRET", "KINDGI_AUTH_SECRET_PATH"]))) == 0 || var.public_url != ""
      error_message = "Sign-in with identity providers (KINDGI_AUTH_SECRET) needs public_url: the URL people open the console at, where identity providers send them back. The server won't start without it."
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.server_reads,
    google_secret_manager_secret_iam_member.server_reads_its_secrets,
    google_kms_crypto_key_iam_member.server_wraps,
    google_kms_crypto_key_iam_member.server_reads_key,
    google_project_iam_member.server_invokes_packs,
    google_secret_manager_secret_iam_member.server_reads_export_key,
    google_kms_crypto_key_iam_member.server_signs_exports,
    google_project_iam_member.server_sql_client,
    google_project_iam_member.server_sql_client_served,
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

# The server calls each deployment's pack service with a Google ID token. The
# pack orchestrator makes and deletes those services, and never sets a
# service's own policy, so the server may invoke the project's Cloud Run
# services: run one installation per project.
resource "google_project_iam_member" "server_invokes_packs" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.server.email}"
}
