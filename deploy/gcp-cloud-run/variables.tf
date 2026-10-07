# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# ---- where ------------------------------------------------------------------

variable "project_id" {
  description = "The GCP project both services, the database and the secrets live in."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL, Artifact Registry and the KMS key ring."
  type        = string
  default     = "northamerica-northeast2"
}

variable "name_prefix" {
  description = "Prefix for every resource name (services, service accounts, secrets, the database)."
  type        = string
  default     = "kindgi"
}

variable "kindgi_env" {
  description = "KINDGI_ENV: the env name this runtime serves. Secrets tools declare by name resolve under it."
  type        = string
}

# ---- images -------------------------------------------------------------------

variable "server_image" {
  description = "The Kindgi runtime image, by digest, in Artifact Registry (Cloud Run can't pull a private Quay image; see README)."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.server_image))
    error_message = "Pin the runtime image by digest (…@sha256:<64 hex>)."
  }
}

variable "pack_image" {
  description = "The pack image `kindgi build` produced, by digest, in Artifact Registry."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.pack_image))
    error_message = "Pin the pack image by digest (…@sha256:<64 hex>)."
  }
}

# ---- the server ---------------------------------------------------------------

variable "server_public" {
  description = "Let anyone reach the server's URL (allUsers run.invoker). The API checks its own bearer tokens either way. false: put it behind IAP or a load balancer yourself."
  type        = bool
  default     = true
}

variable "server_min_instances" {
  description = "Minimum server instances. At least 1: runs started with wait:false keep running after the response, and need an instance (and CPU) to finish on."
  type        = number
  default     = 1

  validation {
    condition     = var.server_min_instances >= 1
    error_message = "Background runs need at least one instance."
  }
}

variable "server_max_instances" {
  description = "Maximum server instances. 1 until multiple replicas are verified: background work (the waitpoint sleeper, sweepers, the webhook worker, schedules) runs in every instance, and scale-in interrupts runs in flight."
  type        = number
  default     = 1
}

variable "nat_static_ip" {
  description = "Reserve a static egress address for Cloud NAT, for allowlists on the other side (the app's webhook receiver, an outbound firewall). false: Google picks and may change it."
  type        = bool
  default     = false
}

variable "cors_origins" {
  description = "KINDGI_CORS_ORIGINS: exact browser origins allowed to follow runs with public run tokens. Empty: none."
  type        = list(string)
  default     = []
}

variable "export_signing" {
  description = "How the server signs exports (approval audit bundles, run provenance, compliance evidence). \"none\": exports answer 404 signing-not-configured. \"secret\": an Ed25519 key in Secret Manager (<name_prefix>-export-signing-key, its PEM base64), as KINDGI_EXPORT_SIGNING_KEY. \"kms\": a Cloud KMS EC_SIGN_ED25519 key version (export_signing_kms_key), as KINDGI_EXPORT_SIGNING_KMS_KEY; the private key never leaves KMS."
  type        = string
  default     = "none"
  validation {
    condition     = contains(["none", "secret", "kms"], var.export_signing)
    error_message = "export_signing must be none, secret or kms."
  }
}

variable "export_signing_kms_key" {
  description = "With export_signing = \"kms\": the key version that signs, projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<n>. The server's service account gets signerVerifier and publicKeyViewer on its key."
  type        = string
  default     = ""
  validation {
    condition     = var.export_signing_kms_key == "" || can(regex("^projects/[^/]+/locations/[^/]+/keyRings/[^/]+/cryptoKeys/[^/]+/cryptoKeyVersions/[0-9]+$", var.export_signing_kms_key))
    error_message = "export_signing_kms_key must be a key version: projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<n>."
  }
}

variable "openfga_api_url" {
  description = "KINDGI_OPENFGA_API_URL. Production must set it: unset, routes mount without authorization."
  type        = string
  default     = ""
}

variable "seed_tenant_id" {
  description = "KINDGI_TENANT_ID: the tenant the server seeds and reuses. Pin it, or every new revision seeds a new one."
  type        = string
}

variable "seed_user_id" {
  description = "KINDGI_SEED_USER_ID: pinned so the FGA admin@tenant tuple stays stable across revisions."
  type        = string
}

# ---- the pack service ---------------------------------------------------------

variable "pack_concurrency" {
  description = "Calls one pack service instance runs at once: both Cloud Run's concurrency and KINDGI_PACK_SERVICE_MAX_CONCURRENCY."
  type        = number
  default     = 32
}

variable "pack_min_instances" {
  description = "Minimum pack service instances (1 keeps the first tool call off a cold start)."
  type        = number
  default     = 1
}

variable "pack_max_instances" {
  description = "Maximum pack service instances."
  type        = number
  default     = 8
}

variable "pack_env" {
  description = "The pack's plain env values: `env` from `kindgi env plan --env <name>` (Terraform output)."
  type        = map(string)
  default     = {}
}

variable "pack_secret_env" {
  description = "The pack's secret env, by reference: `secret_env` from `kindgi env plan`. The operator creates each secret; Cloud Run reads it with the pack service's identity."
  type = map(object({
    secret  = string
    version = string
    project = optional(string)
  }))
  default = {}
}

variable "pack_cloud_sql_instances" {
  description = "Cloud SQL instances the pack's own code connects to (connection names), mounted at /cloudsql."
  type        = list(string)
  default     = []
}

variable "pack_bucket_readers" {
  description = "GCS buckets the pack's code reads (roles/storage.objectViewer for the pack service)."
  type        = list(string)
  default     = []
}

# ---- the database -------------------------------------------------------------

variable "database_tier" {
  description = "Cloud SQL machine tier for Kindgi's own database."
  type        = string
  default     = "db-custom-1-3840"
}

variable "database_version" {
  description = "Cloud SQL's Postgres version. Kindgi is tested on 16."
  type        = string
  default     = "POSTGRES_16"
}

variable "database_edition" {
  description = "Cloud SQL's edition. ENTERPRISE takes the shared-core (db-f1-micro, db-g1-small) and db-custom-* tiers. Postgres 16 instances otherwise default to ENTERPRISE_PLUS, which takes only db-perf-optimized-N-* tiers."
  type        = string
  default     = "ENTERPRISE"
  validation {
    condition     = contains(["ENTERPRISE", "ENTERPRISE_PLUS"], var.database_edition)
    error_message = "database_edition is ENTERPRISE or ENTERPRISE_PLUS."
  }
}

variable "database_name" {
  description = "Kindgi's database on the instance."
  type        = string
  default     = "kindgi"
}

variable "database_private_network" {
  description = <<-EOT
    Empty: public IP with no authorized networks, reached only through the /cloudsql connector (IAM-checked).
    A VPC self-link (projects/<project>/global/networks/<name>): private IP only on that network, which needs private services access already. The server then connects over TCP to the private IP through its VPC egress: KINDGI_DATABASE_URL = postgres://<user>:<password>@<private ip>:5432/<db>?sslmode=require.
  EOT
  type        = string
  default     = ""
}

variable "database_deletion_protection" {
  description = "Keep Terraform (and the console) from deleting Kindgi's database instance."
  type        = bool
  default     = true
}

# ---- network ------------------------------------------------------------------

variable "network_mode" {
  description = <<-EOT
    How both services reach a VPC.
    "direct": greenfield. A new VPC and subnet, Direct VPC egress with all traffic, Cloud NAT, and an internal pack service.
    "connector": an existing Serverless VPC Access connector (vpc_connector) with private-ranges-only egress. No VPC, router or NAT is created; internet-bound calls (model APIs, the pack service's URL, webhooks) use Cloud Run's own egress.
  EOT
  type        = string
  default     = "direct"
  validation {
    condition     = contains(["direct", "connector"], var.network_mode)
    error_message = "network_mode is \"direct\" or \"connector\"."
  }
}

variable "vpc_connector" {
  description = "network_mode = \"connector\": the existing connector, as projects/<project>/locations/<region>/connectors/<name>."
  type        = string
  default     = ""
}

variable "server_cpu" {
  description = "The server's vCPU limit. Its work is I/O-bound: 1 is enough for a dev deployment."
  type        = string
  default     = "2"
}

variable "server_memory" {
  description = "The server's memory limit."
  type        = string
  default     = "2Gi"
}

variable "pack_timeout" {
  description = "The pack service's request timeout (Cloud Run). Above the slowest tool call, and above the server's KINDGI_PACK_CALL_TIMEOUT_MS, so the server reports a timeout before Cloud Run cuts the request."
  type        = string
  default     = "300s"
}

variable "pack_call_timeout_ms" {
  description = "KINDGI_PACK_CALL_TIMEOUT_MS on the server: how long it waits for one tool call (the runtime's default is 120000). Raise it when a tool can take longer, e.g. behind a dependency with long cold starts. null leaves the default."
  type        = number
  default     = null
}

variable "pack_bucket_object_prefixes" {
  description = "Per bucket in pack_bucket_readers, object-name prefixes the pack may read (an IAM condition on its objectViewer grant; the bucket needs uniform bucket-level access). A bucket missing here is readable in full."
  type        = map(list(string))
  default     = {}
}

variable "pack_ingress" {
  description = <<-EOT
    The pack service's ingress.
    INGRESS_TRAFFIC_INTERNAL_ONLY (direct mode): only the VPC reaches it.
    INGRESS_TRAFFIC_ALL (connector mode): a private-ranges-only server can't reach an internal service. IAM still guards it: only the server's service account may invoke it, with a Google ID token (KINDGI_PACK_SERVICE_AUTH=google-id-token).
  EOT
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  validation {
    condition     = contains(["INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_ALL"], var.pack_ingress)
    error_message = "pack_ingress is INGRESS_TRAFFIC_INTERNAL_ONLY or INGRESS_TRAFFIC_ALL."
  }
}

variable "server_invoker_iam_disabled" {
  description = "Let anyone reach the server without Cloud Run IAM (the API still requires its bearer token), instead of an allUsers run.invoker binding (server_public), which an org policy may forbid. Exclusive with server_public."
  type        = bool
  default     = false
}

variable "vertex_ai" {
  description = "Enable the Vertex AI API (aiplatform.googleapis.com) and grant the server's service account roles/aiplatform.user, for Gemini on Vertex with the service's own credentials (ADC)."
  type        = bool
  default     = false
}

variable "subnet_cidr" {
  description = "The subnet Cloud Run's Direct VPC egress uses (the server reaches the internal pack service through it)."
  type        = string
  default     = "10.10.0.0/24"
}
