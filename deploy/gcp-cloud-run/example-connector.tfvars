# Example values (placeholders) for a project that already has a VPC: both
# services use an existing Serverless VPC Access connector with
# private-ranges-only egress, and no VPC, router or NAT is created.
# Copy to <env>.tfvars and fill in.

project_id  = "acme-app-dev"
region      = "northamerica-northeast2"
name_prefix = "kindgi-dev" # one prefix per environment when environments share a project
kindgi_env  = "dev"

network_mode  = "connector"
vpc_connector = "projects/acme-app-dev/locations/northamerica-northeast2/connectors/acme-connector"
# A server without VPC egress (or private-ranges-only) reaches the pack
# service over Cloud Run's own egress, so the pack service takes all
# traffic; IAM still admits only the server's service account.
pack_ingress = "INGRESS_TRAFFIC_ALL"

# Reachable by URL; the API still requires its bearer token. Use this instead
# of server_public when an org policy forbids allUsers bindings.
server_public               = false
server_invoker_iam_disabled = true

# Gemini on Vertex with the server's own service account.
vertex_ai = true

# Kindgi's own instance, through the /cloudsql socket (the server needs no
# VPC then). For private IP only, set database_private_network instead.
database_tier = "db-g1-small"

server_cpu    = "1"
server_memory = "2Gi"

server_image = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"
pack_image   = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/acme-app@sha256:0000000000000000000000000000000000000000000000000000000000000000"

seed_tenant_id = "00000000-0000-0000-0000-000000000001"
seed_user_id   = "00000000-0000-0000-0000-000000000002"

pack_min_instances = 0
pack_max_instances = 2
pack_timeout       = "600s"
# When a tool can wait long on a dependency (the runtime's default is 120 s).
pack_call_timeout_ms = 300000

pack_env = {
  LOG_LEVEL = "info"
}

pack_secret_env = {
  DATABASE_URL = { secret = "acme-app-reader-database-url", version = "latest" }
}

# The pack reads only its own prefix of a shared bucket (uniform bucket-level access).
pack_bucket_readers         = ["acme-app-corpus"]
pack_bucket_object_prefixes = { "acme-app-corpus" = ["acme/derived/"] }
