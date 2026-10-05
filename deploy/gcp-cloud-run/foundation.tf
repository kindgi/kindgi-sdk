# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# APIs, network, identities, the image repository, the KMS key: what both
# services stand on.

locals {
  apis = concat([
    "artifactregistry.googleapis.com",
    "cloudkms.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
  ], var.vertex_ai ? ["aiplatform.googleapis.com"] : [])
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# ---- network ------------------------------------------------------------------
# The pack service accepts only internal traffic. The server reaches it
# through Direct VPC egress with all its traffic routed into this VPC, so
# its internet-bound calls (a model provider's API, webhooks) leave through
# Cloud NAT, and Google APIs through Private Google Access.

locals {
  direct = var.network_mode == "direct"
}

resource "google_compute_network" "kindgi" {
  count                   = local.direct ? 1 : 0
  name                    = var.name_prefix
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "run" {
  count                    = local.direct ? 1 : 0
  name                     = "${var.name_prefix}-run"
  network                  = google_compute_network.kindgi[0].id
  region                   = var.region
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

resource "google_compute_router" "nat" {
  count   = local.direct ? 1 : 0
  name    = "${var.name_prefix}-nat"
  network = google_compute_network.kindgi[0].id
  region  = var.region
}

resource "google_compute_address" "nat" {
  count  = local.direct && var.nat_static_ip ? 1 : 0
  name   = "${var.name_prefix}-nat"
  region = var.region
}

resource "google_compute_router_nat" "nat" {
  count                              = local.direct ? 1 : 0
  name                               = "${var.name_prefix}-nat"
  router                             = google_compute_router.nat[0].name
  region                             = var.region
  nat_ip_allocate_option             = var.nat_static_ip ? "MANUAL_ONLY" : "AUTO_ONLY"
  nat_ips                            = google_compute_address.nat[*].self_link
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.run[0].id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}

# ---- identities ---------------------------------------------------------------
# Each service runs as its own service account: no key files anywhere.

resource "google_service_account" "server" {
  account_id   = "${var.name_prefix}-server"
  display_name = "Kindgi server"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "pack" {
  account_id   = "${var.name_prefix}-pack"
  display_name = "Kindgi pack service"
  depends_on   = [google_project_service.apis]
}

# The server reaches Kindgi's database; the pack service reaches the
# databases its own code uses.
# Only for the /cloudsql socket (a private-IP database is reached over
# TCP, with no IAM check), and only on Kindgi's own instance: the project
# may hold other instances (an app's, production's).
resource "google_project_iam_member" "server_sql_client" {
  count   = var.database_private_network == "" ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.server.email}"

  condition {
    title       = "kindgi-instance-only"
    description = "Kindgi's own Cloud SQL instance only."
    expression  = "resource.name == \"projects/${var.project_id}/instances/${var.name_prefix}\""
  }
}

# Gemini on Vertex with the server's own credentials (ADC).
resource "google_project_iam_member" "server_vertex_ai" {
  count   = var.vertex_ai ? 1 : 0
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.server.email}"
}

resource "google_project_iam_member" "pack_sql_client" {
  count   = length(var.pack_cloud_sql_instances) > 0 ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.pack.email}"
}

resource "google_storage_bucket_iam_member" "pack_reads" {
  for_each = toset(var.pack_bucket_readers)
  bucket   = each.value
  role     = "roles/storage.objectViewer"
  member   = "serviceAccount:${google_service_account.pack.email}"

  # Narrowed to object prefixes when the bucket has them (it holds more
  # than the pack's own data).
  dynamic "condition" {
    for_each = contains(keys(var.pack_bucket_object_prefixes), each.value) ? [1] : []
    content {
      title       = "pack-object-prefixes"
      description = "The pack reads only these prefixes."
      expression = join(" || ", [
        for prefix in var.pack_bucket_object_prefixes[each.value] :
        "resource.name.startsWith(\"projects/_/buckets/${each.value}/objects/${prefix}\")"
      ])
    }
  }
}

# ---- images -------------------------------------------------------------------
# One repository for the runtime image (mirrored from Quay, see the
# README) and the pack images `kindgi build` pushes. Cloud Run pulls with
# its service agent; the server reads deployments' images with its own
# identity (KINDGI_IMAGE_REGISTRY_AUTH=google).

resource "google_artifact_registry_repository" "images" {
  repository_id = var.name_prefix
  location      = var.region
  format        = "DOCKER"
  description   = "Kindgi runtime and pack images"
  depends_on    = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "server_reads_images" {
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.server.email}"
}

# ---- the key that wraps Kindgi's secrets --------------------------------------
# KINDGI_SECRETS_BACKEND=postgres with KMS gcp: secrets set through the API
# are envelope-encrypted in Postgres under this key.

resource "google_kms_key_ring" "kindgi" {
  name       = var.name_prefix
  location   = var.region
  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "secrets" {
  name            = "${var.name_prefix}-secrets"
  key_ring        = google_kms_key_ring.kindgi.id
  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "server_wraps" {
  crypto_key_id = google_kms_crypto_key.secrets.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.server.email}"
}

# A runtime before 0.1.3 checks the key at boot by reading its metadata
# (cloudkms.cryptoKeys.get), which encrypter/decrypter doesn't include:
# without this, its every boot exits 2 ("KMS probe failed at boot:
# kms-unauthorized"). From 0.1.3 the probe is an encrypt/decrypt round trip
# and needs only the role above.
resource "google_kms_crypto_key_iam_member" "server_reads_key" {
  crypto_key_id = google_kms_crypto_key.secrets.id
  role          = "roles/cloudkms.viewer"
  member        = "serviceAccount:${google_service_account.server.email}"
}
