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
  description = "The Kindgi runtime image, by digest, in Artifact Registry (Cloud Run can't pull from a registry that takes a password, like registry.kindgi.com; see README)."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.server_image))
    error_message = "Pin the runtime image by digest (…@sha256:<64 hex>)."
  }
}

variable "pack_image" {
  description = "The pack image `kindgi build` produced, by digest, in Artifact Registry: the one pack service the server calls (KINDGI_PACK_SERVICE_URL). Needed with tenancy = \"single\". Unset with \"multi\", where each deployment is a service of its own: then there's no pack service, no pack account and none of its grants, and pack_env, pack_secret_env, pack_cloud_sql_instances, pack_bucket_readers and pack_run_invokers stay unset (the pack service's other settings do nothing)."
  type        = string
  default     = ""

  validation {
    condition     = var.pack_image == "" || can(regex("@sha256:[0-9a-f]{64}$", var.pack_image))
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
  description = "Minimum server instances. At least 1: runs started with wait:false, improvement passes and eval runs keep running after the response, and need an instance (and CPU) to finish on."
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
  description = "Reserve a static egress address for Cloud NAT, for allowlists on the other side (the app's webhook receiver, an outbound firewall). false: Google picks and may change it. Applies in network_mode = \"direct\", the only mode with a Cloud NAT; no effect in \"connector\", refused in \"none\"."
  type        = bool
  default     = false
}

variable "nat_min_ports_per_vm" {
  description = "Cloud NAT ports each server instance starts with. One port per connection open at once to one destination (address, port and protocol), such as a public-IP database through Cloud Run's Cloud SQL connection or a model API. Near the limit, the NAT doubles the instance's ports, up to nat_max_ports_per_vm, and a new connection can time out while it does: raise this if the NAT's dropped_sent_packets_count shows reason OUT_OF_RESOURCES. A power of two from 32 to 32768. Applies in network_mode = \"direct\", the only mode with a Cloud NAT."
  type        = number
  default     = 64

  validation {
    condition     = contains([32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768], var.nat_min_ports_per_vm)
    error_message = "nat_min_ports_per_vm must be a power of two from 32 to 32768."
  }
}

variable "nat_max_ports_per_vm" {
  description = "The most Cloud NAT ports one server instance grows to. A power of two above nat_min_ports_per_vm, up to 65536. Each NAT address has 64,512 TCP ports for all instances together; with nat_static_ip, its one address is the ceiling. Lowering it on a running NAT breaks the NAT's open connections, and so does a value under 1024 when an older module copy's fixed ports switch to these. Applies in network_mode = \"direct\"."
  type        = number
  default     = 4096

  validation {
    condition     = contains([64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536], var.nat_max_ports_per_vm)
    error_message = "nat_max_ports_per_vm must be a power of two from 64 to 65536."
  }
}

variable "nat_tcp_time_wait_timeout_sec" {
  description = "Seconds Cloud NAT keeps a closed TCP connection's port before another connection can use it. 30 is Google's default for gateways created after September 30, 2026; the Google provider sets 120 when it's unset. Shorter frees ports sooner, at the cost of possibly receiving packets retransmitted from a closed connection. Applies in network_mode = \"direct\"."
  type        = number
  default     = 30

  validation {
    condition     = var.nat_tcp_time_wait_timeout_sec >= 1 && floor(var.nat_tcp_time_wait_timeout_sec) == var.nat_tcp_time_wait_timeout_sec
    error_message = "nat_tcp_time_wait_timeout_sec must be a whole number of seconds, 1 or more."
  }
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

variable "tenancy" {
  description = "KINDGI_TENANCY: how many tenants the server serves. \"single\" (the default): one, seed_tenant_id's, with the one pack service (pack_image). \"multi\" (runtime 0.1.8 or later): every tenant created through the system API, taking each request's tenant from its key or session, with each deployment a service of its own. It sets KINDGI_TENANCY = \"multi\" and no tenant or seed user, takes no pack_image, and needs openfga_api_url, secrets_backend = \"postgres\" and settings in server_env and server_secret_env, which the plan names: README."
  type        = string
  default     = "single"
  validation {
    condition     = contains(["single", "multi"], var.tenancy)
    error_message = "tenancy must be \"single\" or \"multi\"."
  }
}

variable "seed_tenant_id" {
  description = "KINDGI_TENANT_ID: the tenant the server seeds and reuses. Pin it, or every start seeds a new one. Needed with tenancy = \"single\", refused with \"multi\"."
  type        = string
  default     = null
}

variable "seed_user_id" {
  description = "KINDGI_SEED_USER_ID: pinned so the FGA admin@tenant tuple stays stable across revisions. Needed with tenancy = \"single\", refused with \"multi\"."
  type        = string
  default     = null
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

variable "pack_run_invokers" {
  description = "Cloud Run services the pack's code calls, IAM-protected (an app's own service): { project, location, service } each, the service's name, not its URL. The pack's service account gets roles/run.invoker on each. The call leaves through the pack's own egress, so the service's ingress must take it (see the README)."
  type = list(object({
    project  = string
    location = string
    service  = string
  }))
  default = []
  validation {
    condition     = alltrue([for s in var.pack_run_invokers : can(regex("^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$", s.service))])
    error_message = "Each pack_run_invokers service is a Cloud Run service name (lowercase letters, digits and dashes), not its URL."
  }
  validation {
    condition     = length(distinct([for s in var.pack_run_invokers : "${s.project}/${s.location}/${s.service}"])) == length(var.pack_run_invokers)
    error_message = "pack_run_invokers names a service twice."
  }
}

# ---- the database -------------------------------------------------------------

variable "database_tier" {
  description = "Cloud SQL machine tier for Kindgi's own database. Ignored when database_host_instance is set (the host instance's own tier applies)."
  type        = string
  default     = "db-custom-1-3840"
}

variable "database_version" {
  description = "Cloud SQL's Postgres version. Kindgi is tested on 16. Ignored when database_host_instance is set: the host's own version applies, and must be 16 or later (the module checks it)."
  type        = string
  default     = "POSTGRES_16"
}

variable "database_edition" {
  description = "Cloud SQL's edition. ENTERPRISE takes the shared-core (db-f1-micro, db-g1-small) and db-custom-* tiers. Postgres 16 instances otherwise default to ENTERPRISE_PLUS, which takes only db-perf-optimized-N-* tiers. Ignored when database_host_instance is set."
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
    A VPC self-link (projects/<project>/global/networks/<name>): private IP only on that network, which needs private services access already. The server then connects over TCP to the private IP through its VPC egress: KINDGI_DATABASE_URL = postgres://<user>:<password>@<private ip>:5432/<db>?sslmode=require. The module sets KINDGI_DATABASE_SERVER_CA to the instance's CAs, so the server (runtime 0.2.0 on) checks that the database's certificate chains to one of them and is in date.
  EOT
  type        = string
  default     = ""
}

variable "database_backup_retention" {
  description = "How many daily backups Cloud SQL keeps. Null (the default): Cloud SQL's own default, 7 on ENTERPRISE and 15 on ENTERPRISE_PLUS. A deployment others rely on keeps more (30, say). The module's own instance only: refused with database_host_instance (the host's backups are the app's), and not set on an instance database_instance names."
  type        = number
  default     = null
  validation {
    condition     = var.database_backup_retention == null ? true : (floor(var.database_backup_retention) == var.database_backup_retention && var.database_backup_retention >= 1 && var.database_backup_retention <= 365)
    error_message = "database_backup_retention is a whole number of backups, from 1 to 365."
  }
}

variable "database_backup_location" {
  description = "Where Cloud SQL stores the backups: a multi-region (us, eu, asia) or a region (northamerica-northeast2, say). Null (the default): Cloud SQL's own choice, the multi-region nearest the instance, which can be outside the instance's region and country. Set it when you promise where backups are kept. Point-in-time recovery's transaction logs stay in the instance's own location whatever it says. Setting it on a running deployment changes the instance in place, and the backups taken before stay where they were. The module's own instance only: refused with database_host_instance (the host's backups are the app's), and not set on an instance database_instance names."
  type        = string
  default     = null
  validation {
    condition     = var.database_backup_location == null ? true : can(regex("^(us|eu|asia|[a-z]+-[a-z]+[0-9]+)$", var.database_backup_location))
    error_message = "database_backup_location is a region (northamerica-northeast2) or a multi-region (us, eu, asia), not a zone."
  }
}

variable "database_point_in_time_days" {
  description = "How many days of transaction logs point-in-time recovery keeps: any second within them can be restored. Null (the default): Cloud SQL's own default, 7 on ENTERPRISE and 14 on ENTERPRISE_PLUS. At most 7 on ENTERPRISE and 35 on ENTERPRISE_PLUS, and at most as many days as database_backup_retention keeps backups (Cloud SQL's rule), both checked at plan. The module's own instance only: refused with database_host_instance (the host's backups are the app's), and not set on an instance database_instance names."
  type        = number
  default     = null
  validation {
    condition     = var.database_point_in_time_days == null ? true : (floor(var.database_point_in_time_days) == var.database_point_in_time_days && var.database_point_in_time_days >= 1 && var.database_point_in_time_days <= 35)
    error_message = "database_point_in_time_days is a whole number of days, from 1 to 35 (7 on ENTERPRISE)."
  }
}

variable "database_deletion_protection" {
  description = "Keep Terraform from deleting Kindgi's database instance (Terraform's own deletion_protection). It doesn't stop a delete from the console, gcloud or the Cloud SQL API. With database_host_instance set there is no instance of our own, so this instead sets the deletion_policy of Kindgi's database object on the host instance: true keeps the data (ABANDON on a destroy or a database_name change), false deletes it (DELETE)."
  type        = bool
  default     = true
}

variable "database_idle_in_transaction_timeout_ms" {
  description = "The instance's idle_in_transaction_session_timeout, in milliseconds: a backstop that ends any session left idle in a transaction this long, whoever opened it (a psql session left open, say). 0 turns it off. The server's own connections set a shorter one (KINDGI_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, 30 seconds by default), which wins over this. Only on the module's own instance, not on one database_instance names. Ignored when database_host_instance is set: the module makes no instance, and the host's own flags apply."
  type        = number
  default     = 600000

  validation {
    condition     = var.database_idle_in_transaction_timeout_ms >= 0 && var.database_idle_in_transaction_timeout_ms <= 2147483647 && floor(var.database_idle_in_transaction_timeout_ms) == var.database_idle_in_transaction_timeout_ms
    error_message = "A whole number of milliseconds from 0 (off) to 2147483647, Cloud SQL's range for idle_in_transaction_session_timeout."
  }
}

variable "database_instance" {
  description = <<-EOT
    Null: the server uses the module's own Cloud SQL instance and its <prefix>-database-url secret.
    Set, the server serves from another instance in this project instead, such as one a restore made (README, "Serving from a restored instance"): `name` is the instance, with a public IP, and `url_secret` the id of a Secret Manager secret in this project holding the server's URL to it, postgres://<user>:<password>@/<db>?host=/cloudsql/<connection name>. The server's /cloudsql volume then names that instance alone, and the module lets the server's account connect to it as well as to its own, so the old revision serves until the new one is ready.
    Reading url_secret is granted by whoever made it, before the apply: two Terraform roots holding the same grant each remove it for the other when they let go of it. The module's own instance stays as it is. Public-IP mode only (database_private_network empty).
  EOT
  type = object({
    name       = string
    url_secret = string
  })
  default = null

  validation {
    condition     = var.database_instance == null || can(regex("^[a-z][a-z0-9-]*$", var.database_instance.name))
    error_message = "database_instance.name is an instance name in this project: lower-case letters, digits and hyphens, starting with a letter."
  }
  validation {
    condition     = var.database_instance == null || can(regex("^[A-Za-z0-9_-]+$", var.database_instance.url_secret))
    error_message = "database_instance.url_secret is a secret id in this project (letters, digits, _ and -), not a path or a value."
  }
}

variable "database_host_instance" {
  description = <<-EOT
    Null: the module makes its own Cloud SQL instance (the default).
    Set, Kindgi's database and user live on this existing Cloud SQL instance in this project instead, and the module makes no instance of its own. The name is an instance with a public IP, reached through the /cloudsql volume. The module makes Kindgi's database on it; the operator makes Kindgi's user (README, step 3) and fills <prefix>-database-url with the URL, postgres://<user>:<password>@/<db>?host=/cloudsql/<connection name>.
    The instance runs Postgres 16 or later, a role-isolation rule the module checks: before 16, CREATEROLE — which Kindgi's user needs — could grant itself any other user's role. Run one Kindgi deployment per host instance (Kindgi's role and PUBLIC connect are instance-wide), and expect Kindgi to share the instance's CPU, memory, connections and backups with the app. Choose a host or the module's own at the first apply: moving an existing deployment on or off a host instance is a dump and restore, not an in-place change. Public-IP mode only (database_private_network empty).
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.database_host_instance == null || can(regex("^[a-z][a-z0-9-]*$", var.database_host_instance))
    error_message = "database_host_instance is an instance name in this project: lower-case letters, digits and hyphens, starting with a letter."
  }
}

# ---- network ------------------------------------------------------------------

variable "network_mode" {
  description = <<-EOT
    How both services reach a VPC.
    "direct": greenfield. A new VPC and subnet, Direct VPC egress with all traffic, Cloud NAT, and an internal pack service.
    "connector": an existing Serverless VPC Access connector (vpc_connector) with private-ranges-only egress. No VPC, router or NAT is created; internet-bound calls (model APIs, the pack service's URL, webhooks) use Cloud Run's own egress.
    "none": no VPC at all; nothing is created. For a small dev deployment next to an app. The server reaches a public-IP database through /cloudsql and the pack service through its public URL (IAM still guards it); internet-bound calls use Cloud Run's own egress. No private-IP database and no static egress IP.
  EOT
  type        = string
  default     = "direct"
  validation {
    condition     = contains(["direct", "connector", "none"], var.network_mode)
    error_message = "network_mode is \"direct\", \"connector\" or \"none\"."
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
    INGRESS_TRAFFIC_ALL (connector or none mode): a server without VPC egress can't reach an internal service. IAM still guards it: only the server's service account may invoke it, with a Google ID token (KINDGI_PACK_SERVICE_AUTH=google-id-token).
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

variable "secrets_aad_key_version" {
  description = "With secrets_backend = \"postgres\" (required then): the Secret Manager version of KINDGI_SECRETS_AAD_KEY the server reads, \"1\" for a new deployment (the first version added). Pin it; never \"latest\". Every secret stored in Postgres is bound to this key, so a new version is a key change that needs every stored secret re-encrypted, and a version added by mistake must not reach the server."
  type        = string
  default     = null
  validation {
    condition     = var.secrets_aad_key_version == null || can(regex("^[1-9][0-9]*$", var.secrets_aad_key_version))
    error_message = "secrets_aad_key_version is a version number (\"1\" for a new deployment), never \"latest\": every secret stored in Postgres is bound to the key it names."
  }
}

variable "secrets_backend" {
  description = "Where secrets set through Kindgi's API live (KINDGI_SECRETS_BACKEND). \"postgres\" (default): envelope-encrypted in Kindgi's database under a Cloud KMS key the module creates, with secrets_aad_key_version required. \"none\": the runtime stores no secrets of its own (no KMS key, no AAD key); for a deployment whose pack secrets all come by reference from Secret Manager and whose model uses the service's own credentials."
  type        = string
  default     = "postgres"
  validation {
    condition     = contains(["postgres", "none"], var.secrets_backend)
    error_message = "secrets_backend is \"postgres\" or \"none\"."
  }
}

variable "image_repository" {
  description = "An existing Artifact Registry repository for the runtime and pack images, instead of the module's own (<name_prefix>): { project, location, repository }. The server's service account gets roles/artifactregistry.reader on it (and, in another project, this project's Cloud Run service agent too, to pull). Check its cleanup policies keep the digests a running revision pins."
  type = object({
    project    = string
    location   = string
    repository = string
  })
  default = null
}

variable "trusted_proxies" {
  description = "KINDGI_TRUSTED_PROXIES on the server: which proxies in front of it to trust for a client's address, which rate limits and audit records use. A hop count, or comma-separated IPs/CIDR ranges. Cloud Run's front end appends the client to X-Forwarded-For, so 1; add one for each proxy you put in front of it (an external Application Load Balancer: 2). Empty leaves it unset, and every client counts as Cloud Run's front end."
  type        = string
  default     = "1"

  validation {
    condition     = var.trusted_proxies == "" || can(regex("^[1-9][0-9]*$", var.trusted_proxies)) || can(regex("^[0-9a-fA-F]*[.:][0-9a-fA-F:./]*( *, *[0-9a-fA-F]*[.:][0-9a-fA-F:./]*)*$", var.trusted_proxies))
    error_message = "trusted_proxies: a hop count (1, 2, ...) or comma-separated IPs/CIDR ranges."
  }
}

variable "public_url" {
  description = "KINDGI_PUBLIC_URL on the server: the URL people open the console at, such as `terraform output -raw server_url` after the first apply, or your own domain. Sign-in with identity providers and the emailed link need it; console sign-in with an API token doesn't. When set, console sessions are accepted from this origin only. Empty leaves it unset."
  type        = string
  default     = ""

  validation {
    condition     = var.public_url == "" || can(regex("^https://[^/?#]+/?$", var.public_url))
    error_message = "public_url: an https:// origin with no path, such as https://kindgi.example.com."
  }
}

variable "server_env" {
  description = "The server's own settings beyond the ones this module sets, as plain values: sign-in (`KINDGI_CONSOLE_TOKEN_SIGN_IN = \"on\"`, `KINDGI_AUTH_EMAIL_FROM`, ...) and others. A secret goes in server_secret_env instead. A name the module sets itself is refused."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for name in keys(var.server_env) : can(regex("^[A-Z_][A-Z0-9_]*$", name))])
    error_message = "server_env: a name is upper-case letters, digits and underscores."
  }
  validation {
    condition     = alltrue([for name in keys(var.server_env) : !can(regex("SECRET|_SMTP_URL$|_PRESHARED_KEY$", name))])
    error_message = "server_env: a secret (a *SECRET* name, a preshared key, or the SMTP URL with its password) goes in server_secret_env, by reference to Secret Manager, so its value isn't in the plan, the state or the service's configuration."
  }
}

variable "server_secret_env" {
  description = "The server's secret settings, by reference to Secret Manager: `KINDGI_AUTH_SECRET`, `KINDGI_AUTH_EMAIL_SMTP_URL`, ... The operator creates each secret; the server's service account gets read access to exactly these (one in another project is granted there). A name the module sets itself is refused."
  type = map(object({
    secret  = string
    version = string
    project = optional(string)
  }))
  default = {}

  validation {
    condition     = alltrue([for name in keys(var.server_secret_env) : can(regex("^[A-Z_][A-Z0-9_]*$", name))])
    error_message = "server_secret_env: a name is upper-case letters, digits and underscores."
  }
}
