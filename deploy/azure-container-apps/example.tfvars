# Example values (placeholders) for the new-VNet shape. Copy to <env>.tfvars,
# fill in, and write the pack's env from `kindgi env plan --env <name>` to
# <env>.pack-env.auto.tfvars.json in this directory (README step 4).

subscription_id     = "00000000-0000-0000-0000-000000000000"
resource_group_name = "acme-kindgi-dev"
kindgi_env          = "dev"

tags = {
  owner   = "platform-team"
  purpose = "kindgi-dev"
}

server_image = "kindgiab12.azurecr.io/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"
pack_image   = "kindgiab12.azurecr.io/acme-app@sha256:0000000000000000000000000000000000000000000000000000000000000000"

seed_tenant_id = "00000000-0000-0000-0000-000000000001"
seed_user_id   = "00000000-0000-0000-0000-000000000002"

# The version of the AAD key the server reads: the id `az keyvault secret set`
# printed for secrets-aad-key (README step 3), its last segment. Pinned, never
# "latest": every secret stored in Postgres is bound to it.
secrets_aad_key_version = "0123456789abcdef0123456789abcdef"

cors_origins = ["https://app.acme.example"]

pack_env = {
  LOG_LEVEL = "info"
}

pack_secret_env = {
  ACME_API_KEY = { secret = "acme-api-key", version = "latest" }
}
