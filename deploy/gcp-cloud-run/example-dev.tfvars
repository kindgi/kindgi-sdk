# Example values (placeholders) for a small dev deployment that shares an
# app's Cloud SQL instance and needs no VPC of its own. Not for production.
# Copy to <env>.tfvars and fill in.

project_id  = "acme-app-dev"
region      = "northamerica-northeast2"
name_prefix = "kindgi-dev" # one prefix per environment when environments share a project
kindgi_env  = "dev"

# No VPC: the server reaches the internet and the pack services over Cloud
# Run's own egress, so each pack service takes all ingress (IAM still admits
# only the project's invokers, the server's account among them). No
# private-IP database, no static egress IP.
network_mode = "none"
pack_ingress = "INGRESS_TRAFFIC_ALL"

# Reachable by URL; the API still requires its bearer token. Use this instead
# of server_public when an org policy forbids allUsers bindings.
server_public               = false
server_invoker_iam_disabled = true

# Gemini on Vertex with the server's own service account (no model key stored).
vertex_ai = true

# Kindgi's database and user on the app's existing Cloud SQL instance; the
# module makes no instance of its own. The instance has a public IP and runs
# Postgres 16 or later. The module creates Kindgi's database on it; the
# operator creates Kindgi's user and fills <name_prefix>-database-url with the
# URL (README, step 3).
database_host_instance = "acme-app-dev-db"

server_cpu    = "1"
server_memory = "2Gi"
# One always-on server instance.
server_min_instances = 1

server_image = "northamerica-northeast2-docker.pkg.dev/acme-app-dev/kindgi-dev/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"

seed_tenant_id = "00000000-0000-0000-0000-000000000001"
seed_user_id   = "00000000-0000-0000-0000-000000000002"

# The version of the AAD key the server reads: the first one added (README step 3).
# Pinned, never "latest". Needed with the default secrets_backend = "postgres";
# set secrets_backend = "none" instead if you store no model keys (Vertex AI).
secrets_aad_key_version = "1"

# Set after the first apply, once the orchestrator's key is minted and added
# (README, "5. The pack orchestrator"). Pinned, never "latest".
# orchestrator_key_version = "1"

# Each pack service scales to zero unless its version is pinned; the first
# tool call after idle cold-starts.
pack_max_instances = 2
