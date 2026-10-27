# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The two Cloud Run services: the pack service (runs the pack's code,
# internal only) and the server (the API, agent and flow execution).

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
    "KINDGI_PACK_CALL_TIMEOUT_MS", "KINDGI_PACK_SERVICE_AUTH", "KINDGI_PACK_SERVICE_TOKEN",
    "KINDGI_PACK_SERVICE_URL", "KINDGI_PUBLIC_TOKEN_SIGNING_KEY", "KINDGI_PUBLIC_URL",
    "KINDGI_SECRETS_AAD_KEY", "KINDGI_SECRETS_BACKEND", "KINDGI_SECRETS_BACKEND_KMS",
    "KINDGI_SECRETS_GCP_KEY_ID", "KINDGI_SECRETS_GCP_KEY_RING_ID", "KINDGI_SECRETS_GCP_LOCATION_ID",
    "KINDGI_SECRETS_GCP_PROJECT_ID", "KINDGI_SEED_USER_ID", "KINDGI_TENANCY", "KINDGI_TENANT_ID",
    "KINDGI_TRUSTED_PROXIES",
  ])
  server_extra_env = setunion(keys(var.server_env), keys(var.server_secret_env))

  # What a server serving many tenants needs, each named when it's missing.
  multi_missing = compact([
    var.openfga_api_url == "" ? "openfga_api_url (without an authorization store, no tenant would have an admin)" : "",
    contains(keys(var.server_secret_env), "KINDGI_OPENFGA_PRESHARED_KEY") ? "" : "server_secret_env's KINDGI_OPENFGA_PRESHARED_KEY (a key the authorization store accepts)",
    lookup(var.server_env, "KINDGI_TENANT_HOST_ACCESS", "") == "isolated" ? "" : "server_env's KINDGI_TENANT_HOST_ACCESS = \"isolated\"",
    lookup(var.server_env, "KINDGI_PACK_ROUTING", "") == "per-deployment" ? "" : "server_env's KINDGI_PACK_ROUTING = \"per-deployment\"",
    lookup(var.server_env, "KINDGI_PACK_ENDPOINT_HOSTS", "") != "" ? "" : "server_env's KINDGI_PACK_ENDPOINT_HOSTS (the hosts a deployment's endpoint may be on)",
    var.secrets_backend == "postgres" ? "" : "secrets_backend = \"postgres\" (each endpoint's token is sealed under the secrets' key)",
  ])
}

# ---- the pack service ---------------------------------------------------------

resource "google_cloud_run_v2_service" "pack" {
  count               = local.pack ? 1 : 0
  name                = "${var.name_prefix}-pack"
  location            = var.region
  ingress             = var.pack_ingress
  deletion_protection = false

  template {
    service_account                  = google_service_account.pack[0].email
    timeout                          = var.pack_timeout
    max_instance_request_concurrency = var.pack_concurrency

    scaling {
      min_instance_count = var.pack_min_instances
      max_instance_count = var.pack_max_instances
    }

    # Connector mode: the pack's code reaches private IPs (an app
    # database) through the existing connector. Not in direct mode (the pack
    # is internal) or none (no VPC).
    dynamic "vpc_access" {
      for_each = var.network_mode == "connector" ? [1] : []
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
        # CPU only while a call runs: the service does no work between
        # calls, so the instance pack_min_instances keeps up bills at the
        # idle rate. Named because with limits set, Cloud Run otherwise
        # keeps CPU allocated. The boost shortens the start, which imports
        # every module before it listens.
        cpu_idle          = true
        startup_cpu_boost = true
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
      # Two minutes in all, asked every 2 s: a started instance takes no
      # request until the probe passes, so a cold start's first tool call
      # waits about 1 s for it, where every 5 s made that about 2.5 s. The
      # timeout stays under the period.
      startup_probe {
        http_get {
          path = "/readyz"
          port = 8080
        }
        period_seconds    = 2
        timeout_seconds   = 1
        failure_threshold = 60
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
  count    = local.pack ? 1 : 0
  name     = google_cloud_run_v2_service.pack[0].name
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
      # ID token per call (KINDGI_PACK_SERVICE_AUTH). Without a pack image
      # there's no pack service, and so none of the three: each deployment
      # is a service of its own (KINDGI_PACK_ROUTING=per-deployment), whose
      # endpoint carries its own token and auth, and the server refuses them.
      dynamic "env" {
        for_each = local.pack ? [google_cloud_run_v2_service.pack[0].uri] : []
        content {
          name  = "KINDGI_PACK_SERVICE_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.pack ? [google_secret_manager_secret.shared["pack_service_token"].secret_id] : []
        content {
          name = "KINDGI_PACK_SERVICE_TOKEN"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = local.pack ? ["google-id-token"] : []
        content {
          name  = "KINDGI_PACK_SERVICE_AUTH"
          value = env.value
        }
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
      condition     = !local.pack || var.network_mode == "direct" || var.pack_ingress == "INGRESS_TRAFFIC_ALL"
      error_message = "network_mode = \"connector\" or \"none\" needs pack_ingress = \"INGRESS_TRAFFIC_ALL\": a server without a VPC reaches the pack service over its public URL (IAM still admits only the server's account)."
    }
    precondition {
      condition = local.pack || (
        length(var.pack_env) == 0 && length(var.pack_secret_env) == 0 && length(var.pack_cloud_sql_instances) == 0
        && length(var.pack_bucket_readers) == 0 && length(var.pack_run_invokers) == 0
      )
      error_message = "pack_env, pack_secret_env, pack_cloud_sql_instances, pack_bucket_readers and pack_run_invokers configure the one pack service, which exists only with pack_image: set pack_image, or unset them."
    }
    precondition {
      condition     = var.tenancy != "single" || local.pack
      error_message = "tenancy = \"single\" needs pack_image: the one pack service the server calls."
    }
    precondition {
      condition     = var.tenancy != "single" || contains(["", "single"], trimspace(lookup(var.server_env, "KINDGI_PACK_ROUTING", "")))
      error_message = "tenancy = \"single\" calls the one pack service: server_env's KINDGI_PACK_ROUTING, if set, is empty or \"single\". \"per-deployment\" needs tenancy = \"multi\"."
    }
    precondition {
      condition     = var.tenancy != "multi" || !local.pack
      error_message = "tenancy = \"multi\" takes no pack_image: each deployment is a service of its own, whose endpoint carries its own URL, token and auth, and the server refuses the one pack service's. Leave it unset."
    }
    precondition {
      condition     = !local.kms || var.secrets_aad_key_version != null
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
