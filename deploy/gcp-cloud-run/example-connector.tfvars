# Example values (placeholders) for a project that already has a VPC: the
# server and the pack services use an existing Serverless VPC Access
# connector with private-ranges-only egress, and no VPC, router or NAT is
# created.
# Copy to <env>.tfvars and fill in.

project_id  = "acme-app-dev"
region      = "northamerica-northeast2"
name_prefix = "kindgi-dev" # one installation per project: environments never share one
kindgi_env  = "dev"

network_mode  = "connector"
vpc_connector = "projects/acme-app-dev/locations/northamerica-northeast2/connectors/acme-connector"
# A server without VPC egress (or private-ranges-only) reaches the pack
# services over Cloud Run's own egress, so each pack service takes all
# traffic; IAM still admits only the project's invokers, the server's
# service account among them.
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

seed_tenant_id = "00000000-0000-0000-0000-000000000001"
seed_user_id   = "00000000-0000-0000-0000-000000000002"

# The version of the AAD key the server reads: the first one added (README step 3).
# Pinned, never "latest": every secret stored in Postgres is bound to it.
secrets_aad_key_version = "1"

# Set after the first apply, once the orchestrator's key is minted and added
# (README, "5. The pack orchestrator"). Pinned, never "latest".
# orchestrator_key_version = "1"

pack_max_instances = 2
pack_timeout       = "600s"
# When a tool can wait long on a dependency (the runtime's default is 120 s).
pack_call_timeout_ms = 300000

# A secret of yours that the pack's env names as a cloud secret, pinned to a
# version. List it here and apply first, then set it, with a system key
# holding system:env-refs (README, "The pack services"):
#   kindgi env set DATABASE_URL --cloud-secret
#   projects/acme-app-dev/secrets/acme-app-reader-database-url/versions/1
#   --tenant=<id> --scope=tenant --env=<env>
# pack_secret_readers = [{ secret = "acme-app-reader-database-url" }]

# The pack reads only its own prefix of a shared bucket (uniform bucket-level access).
pack_bucket_readers         = ["acme-app-corpus"]
pack_bucket_object_prefixes = { "acme-app-corpus" = ["acme/derived/"] }

# An app service the pack's code calls with a Google ID token. Its ingress
# is all, with IAM as the guard: a pack service's egress isn't internal.
pack_run_invokers = [
  { project = "acme-app-dev", location = "northamerica-northeast2", service = "acme-search" },
]

# Console sign-in with the API token (off by default since runtime 0.1.5).
# More sign-in settings: README, "7. Turn on sign-in".
server_env = {
  KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
}
