# Example values (placeholders). Copy to <env>.tfvars, fill in, and add the
# pack's env from `kindgi env plan --env <name>` (Terraform output) as
# pack_env / pack_secret_env, or pass that JSON as <env>.pack-env.auto.tfvars.json
# after renaming its keys to pack_env / pack_secret_env.

project_id = "acme-kindgi-dev"
region     = "northamerica-northeast2"
kindgi_env = "dev"

server_image = "northamerica-northeast2-docker.pkg.dev/acme-kindgi-dev/kindgi/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"
pack_image   = "northamerica-northeast2-docker.pkg.dev/acme-kindgi-dev/kindgi/acme-app@sha256:0000000000000000000000000000000000000000000000000000000000000000"

seed_tenant_id = "00000000-0000-0000-0000-000000000001"
seed_user_id   = "00000000-0000-0000-0000-000000000002"

# The version of the AAD key the server reads: the first one added (README step 3).
# Pinned, never "latest": every secret stored in Postgres is bound to it.
secrets_aad_key_version = "1"

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

# Renew the license key on a schedule (README, step 8). Unset: by hand only.
# license_renewal_schedule = "17 6 * * *"

pack_env = {
  LOG_LEVEL = "info"
}

pack_secret_env = {
  DATABASE_URL = { secret = "acme-app-database-url", version = "3" }
}

pack_cloud_sql_instances = ["acme-kindgi-dev:northamerica-northeast2:acme-app"]
pack_bucket_readers      = ["acme-app-corpus"]
