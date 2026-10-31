# Example values (placeholders). Copy to <env>.tfvars and fill in. The pack's
# env isn't set here: each deployment's pack service gets it from the runtime
# (README, "The pack services").

project_id = "acme-kindgi-dev"
region     = "northamerica-northeast2"
kindgi_env = "dev"

server_image = "northamerica-northeast2-docker.pkg.dev/acme-kindgi-dev/kindgi/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"

seed_tenant_id = "00000000-0000-0000-0000-000000000001"
seed_user_id   = "00000000-0000-0000-0000-000000000002"

# The version of the AAD key the server reads: the first one added (README step 3).
# Pinned, never "latest": every secret stored in Postgres is bound to it.
secrets_aad_key_version = "1"

# Set after the first apply, once the orchestrator's key is minted and added
# (README, "5. The pack orchestrator"). Pinned, never "latest".
# orchestrator_key_version = "1"

cors_origins = ["https://app.acme.example"]

# One server instance until multiple replicas are verified (the default).
server_max_instances = 1
# A fixed egress address, if the app's side allowlists where webhooks come from.
nat_static_ip = false

# Console sign-in with the API token (off by default since runtime 0.1.5).
# More sign-in settings: README, "7. Turn on sign-in".
server_env = {
  KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
}

# A secret of yours that the pack's env names as a cloud secret, pinned to a
# version there: kindgi env set DATABASE_URL --cloud-secret
# projects/acme-kindgi-dev/secrets/acme-app-database-url/versions/3
#   --tenant=<id> --scope=tenant --env=<env>
# pack_secret_readers = [{ secret = "acme-app-database-url" }]

pack_cloud_sql_instances = ["acme-kindgi-dev:northamerica-northeast2:acme-app"]
pack_bucket_readers      = ["acme-app-corpus"]
