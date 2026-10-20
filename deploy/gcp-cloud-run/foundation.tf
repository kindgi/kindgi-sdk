# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# APIs, network, identities, the image repository, the KMS key: what both
# services stand on.

locals {
  # The KMS key exists only for KINDGI_SECRETS_BACKEND=postgres (var.secrets_backend).
  kms = var.secrets_backend == "postgres"

  # The module's own Cloud Resource Manager calls (the project IAM members,
  # the project read) are billed to the caller's project, so they don't need
  # it on here. A root beside it that reads this project with calls billed to
  # the project (the provider's user_project_override) does, and can't turn
  # it on itself: a data source reads before any resource is made.
  apis = concat([
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
  ], local.kms ? ["cloudkms.googleapis.com"] : [], var.vertex_ai ? ["aiplatform.googleapis.com"] : [])
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
  # The one pack service, its account and its grants: only with a pack image.
  pack = var.pack_image != ""
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

  # Ports per server instance grow on demand: Google's fixed 64 caps an instance
  # at 64 connections open at once to one destination, such as a public-IP
  # database through Cloud Run's Cloud SQL connection. Dynamic allocation needs
  # endpoint-independent mapping off. The provider defaults TIME_WAIT to 120 s.
  enable_dynamic_port_allocation      = true
  enable_endpoint_independent_mapping = false
  min_ports_per_vm                    = var.nat_min_ports_per_vm
  max_ports_per_vm                    = var.nat_max_ports_per_vm
  tcp_time_wait_timeout_sec           = var.nat_tcp_time_wait_timeout_sec

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
  count        = local.pack ? 1 : 0
  account_id   = "${var.name_prefix}-pack"
  display_name = "Kindgi pack service"
  depends_on   = [google_project_service.apis]
}

# The server reaches Kindgi's database; the pack service reaches the
# databases its own code uses.
# Only for the /cloudsql socket (a private-IP database is reached over
# TCP, with no IAM check), and only on Kindgi's instance — the module's own,
# or database_host_instance's shared one: the project may hold other
# instances (an app's, production's).
resource "google_project_iam_member" "server_sql_client" {
  count   = var.database_private_network == "" ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.server.email}"

  condition {
    title       = "kindgi-instance-only"
    description = "Kindgi's Cloud SQL instance only (the module's own, or database_host_instance's)."
    expression  = "resource.name == \"projects/${var.project_id}/instances/${var.database_host_instance != null ? var.database_host_instance : var.name_prefix}\""
  }
}

# The instance it serves from instead (database_instance), as well: the old
# revision keeps its own until the new one takes the traffic. Its own
# condition, so a grant another root makes on the same instance is a
# binding of its own, never this one.
resource "google_project_iam_member" "server_sql_client_served" {
  count   = var.database_instance != null && var.database_private_network == "" ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.server.email}"

  condition {
    title       = "kindgi-served-instance-only"
    description = "The Cloud SQL instance Kindgi's server serves from (database_instance) only."
    expression  = "resource.name == \"projects/${var.project_id}/instances/${var.database_instance.name}\""
  }

  # The server depends on this grant, and a plain dependency removes it before
  # the server changes: on the way back (null) the revision still serving from
  # this instance would lose it, and so would a move to another restored
  # instance, since a new condition replaces the member. Created before
  # destroyed, the old grant goes only after the server's new revision is in.
  # A mock plan can't show the order, so no test checks it.
  lifecycle {
    create_before_destroy = true
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
  count   = local.pack && length(var.pack_cloud_sql_instances) > 0 ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.pack[0].email}"
}

resource "google_storage_bucket_iam_member" "pack_reads" {
  for_each = local.pack ? toset(var.pack_bucket_readers) : toset([])
  bucket   = each.value
  role     = "roles/storage.objectViewer"
  member   = "serviceAccount:${google_service_account.pack[0].email}"

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

# The Cloud Run services the pack's code calls (C-PK-6): additive, one
# member per service; nothing else of the service changes.
resource "google_cloud_run_v2_service_iam_member" "pack_invokes" {
  for_each = { for s in var.pack_run_invokers : "${s.project}/${s.location}/${s.service}" => s if local.pack }
  project  = each.value.project
  location = each.value.location
  name     = each.value.service
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pack[0].email}"
}

# ---- images -------------------------------------------------------------------
# One repository for the runtime image (mirrored from Quay, see the
# README) and the pack images `kindgi build` pushes: the module's own, or
# an existing one (var.image_repository). Cloud Run pulls with its service
# agent; the server reads deployments' images with its own identity
# (KINDGI_IMAGE_REGISTRY_AUTH=google).

locals {
  own_repository = var.image_repository == null
  # An existing repository in another project: this project's Cloud Run
  # service agent needs to read it too, to pull the images.
  cross_project_repository = !local.own_repository && try(var.image_repository.project, var.project_id) != var.project_id
}

resource "google_artifact_registry_repository" "images" {
  count         = local.own_repository ? 1 : 0
  repository_id = var.name_prefix
  location      = var.region
  format        = "DOCKER"
  description   = "Kindgi runtime and pack images"
  depends_on    = [google_project_service.apis]
}

# A deployment from before image_repository keeps its repository at index 0.
moved {
  from = google_artifact_registry_repository.images
  to   = google_artifact_registry_repository.images[0]
}

resource "google_artifact_registry_repository_iam_member" "server_reads_images" {
  project    = local.own_repository ? null : var.image_repository.project
  repository = local.own_repository ? google_artifact_registry_repository.images[0].name : var.image_repository.repository
  location   = local.own_repository ? var.region : var.image_repository.location
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.server.email}"
}

data "google_project" "this" {
  count      = local.cross_project_repository ? 1 : 0
  project_id = var.project_id
}

resource "google_artifact_registry_repository_iam_member" "run_agent_pulls_images" {
  count      = local.cross_project_repository ? 1 : 0
  project    = var.image_repository.project
  repository = var.image_repository.repository
  location   = var.image_repository.location
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-${data.google_project.this[0].number}@serverless-robot-prod.iam.gserviceaccount.com"
}

# ---- the key that wraps Kindgi's secrets --------------------------------------
# KINDGI_SECRETS_BACKEND=postgres with KMS gcp: secrets set through the API
# are envelope-encrypted in Postgres under this key. With
# secrets_backend = "none" the runtime stores no secrets, and there is no key.

resource "google_kms_key_ring" "kindgi" {
  count      = local.kms ? 1 : 0
  name       = var.name_prefix
  location   = var.region
  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "secrets" {
  count           = local.kms ? 1 : 0
  name            = "${var.name_prefix}-secrets"
  key_ring        = google_kms_key_ring.kindgi[0].id
  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "server_wraps" {
  count         = local.kms ? 1 : 0
  crypto_key_id = google_kms_crypto_key.secrets[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.server.email}"
}

# A runtime before 0.1.3 checks the key at boot by reading its metadata
# (cloudkms.cryptoKeys.get), which encrypter/decrypter doesn't include:
# without this, its every boot exits 2 ("KMS probe failed at boot:
# kms-unauthorized"). From 0.1.3 the probe is an encrypt/decrypt round trip
# and needs only the role above.
resource "google_kms_crypto_key_iam_member" "server_reads_key" {
  count         = local.kms ? 1 : 0
  crypto_key_id = google_kms_crypto_key.secrets[0].id
  role          = "roles/cloudkms.viewer"
  member        = "serviceAccount:${google_service_account.server.email}"
}

# A deployment from before secrets_backend keeps its key: the resources
# gained a count, and their state moves to index 0, so it plans no change.
moved {
  from = google_kms_key_ring.kindgi
  to   = google_kms_key_ring.kindgi[0]
}

moved {
  from = google_kms_crypto_key.secrets
  to   = google_kms_crypto_key.secrets[0]
}

moved {
  from = google_kms_crypto_key_iam_member.server_wraps
  to   = google_kms_crypto_key_iam_member.server_wraps[0]
}

moved {
  from = google_kms_crypto_key_iam_member.server_reads_key
  to   = google_kms_crypto_key_iam_member.server_reads_key[0]
}
