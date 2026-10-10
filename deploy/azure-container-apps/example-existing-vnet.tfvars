# Example values (placeholders) for the existing-VNet shape: the pack's tools
# reach private resources in a VNet the app already uses (an app database,
# internal services, private endpoints). The module creates no network: give
# it two empty delegated subnets in that VNet and a private DNS zone for
# PostgreSQL linked to it.

subscription_id     = "00000000-0000-0000-0000-000000000000"
resource_group_name = "acme-kindgi-dev"
kindgi_env          = "dev"

server_image = "kindgiab12.azurecr.io/runtime@sha256:0000000000000000000000000000000000000000000000000000000000000000"
pack_image   = "kindgiab12.azurecr.io/acme-app@sha256:0000000000000000000000000000000000000000000000000000000000000000"

seed_tenant_id = "00000000-0000-0000-0000-000000000001"
seed_user_id   = "00000000-0000-0000-0000-000000000002"

secrets_aad_key_version    = "0123456789abcdef0123456789abcdef"
erasure_ledger_key_version = "fedcba9876543210fedcba9876543210"

# Delegated to Microsoft.App/environments, /27 or larger, empty.
environment_subnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-network/providers/Microsoft.Network/virtualNetworks/acme-vnet/subnets/kindgi-aca"
# Delegated to Microsoft.DBforPostgreSQL/flexibleServers, empty.
database_subnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-network/providers/Microsoft.Network/virtualNetworks/acme-vnet/subnets/kindgi-pg"
# Ends in .postgres.database.azure.com, linked to acme-vnet.
database_private_dns_zone_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/acme-network/providers/Microsoft.Network/privateDnsZones/kindgi.private.postgres.database.azure.com"

# VNet only: the server's URL is reachable from acme-vnet (and what's
# connected to it), not from the internet.
environment_internal = true

pack_secret_env = {
  ACME_DATABASE_URL = { secret = "acme-app-database-url", version = "latest" }
}
