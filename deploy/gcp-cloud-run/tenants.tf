# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# A pack account per tenant (pack_accounts = "per-tenant"). Each tenant in
# pack_tenants gets an account of its own. It reads only the secrets under
# its own prefix and the pack_secret_readers secrets listed for it, and the
# pack orchestrator places that tenant's pack services as it. What every
# tenant may reach stays install-wide: the Cloud SQL instances, the buckets
# and the services the packs call.

locals {
  per_tenant = var.pack_accounts == "per-tenant"

  # A tenant's key: kp-t and the first 16 hex digits of the hash of the
  # install's name and the tenant's id. One string is both the account's id
  # and the prefix of every secret of the tenant's pack services
  # (kp-t<16 hex>-), 20 characters for any name_prefix. With the install's
  # name in the hash, two installations in one project never share a
  # tenant's account. Keyed by the id in lower case: the runtime matches ids
  # in any case, so an edit to an id's case replaces nothing. Distinct, so an
  # id repeated in another case is refused by pack_tenants' own check alone.
  tenant_keys = local.per_tenant ? {
    for id in distinct([for i in var.pack_tenants : lower(i)]) : id => "kp-t${substr(sha256("${var.name_prefix}/${id}"), 0, 16)}"
  } : {}

  # Built as strings, as the pack account's is in the Job's env: each grant's
  # member is known at plan. So each grant names the accounts in depends_on.
  tenant_accounts = { for id, key in local.tenant_keys : id => "${key}@${var.project_id}.iam.gserviceaccount.com" }

  # The pack_secret_readers secrets each tenant reads, "<secret>|<tenant>",
  # once for a tenant an entry lists twice. A tenant not in pack_tenants gets
  # none: the orchestrator's check refuses it.
  tenant_cloud_secrets = local.per_tenant ? {
    for pair in flatten([
      for s in var.pack_secret_readers : [
        for id in distinct([for i in coalesce(s.tenants, []) : lower(i)]) : {
          secret = "projects/${coalesce(s.project, var.project_id)}/secrets/${s.secret}"
          tenant = id
        } if contains(keys(local.tenant_keys), id)
      ]
    ]) : "${pair.secret}|${pair.tenant}" => pair
  } : {}

  # The Cloud SQL instances as IAM names them. A connection name is
  # <project>:<region>:<instance>, and the project may hold a domain
  # (example.com:project).
  pack_sql_instances = [
    for c in var.pack_cloud_sql_instances : try(regex("^(.+):[^:]+:([^:]+)$", c), null)
  ]
}

# ---- each tenant's account -------------------------------------------------------

resource "google_service_account" "tenant" {
  for_each     = local.tenant_keys
  account_id   = each.value
  display_name = "Kindgi pack services: tenant ${each.key}"
  depends_on   = [google_project_service.apis]
}

# Its own pack services' token and secret env values, under its prefix only.
# Every tenant's grant has the same title and description, which never change:
# the provider replaces a grant when any of the condition's fields does.
resource "google_project_iam_member" "tenant_reads_own_secrets" {
  for_each = local.tenant_keys
  project  = var.project_id
  role     = "roles/secretmanager.secretAccessor"
  member   = "serviceAccount:${local.tenant_accounts[each.key]}"

  condition {
    title       = "kindgi-tenant-secrets-only"
    description = "This tenant's pack services' own secrets (kp-t...-) only."
    expression  = "resource.name.startsWith(\"projects/${local.project_number}/secrets/${each.value}-\")"
  }
  depends_on = [google_service_account.tenant]
}

# The orchestrator places the tenant's pack services as its account, and only
# that one.
resource "google_service_account_iam_member" "orchestrator_acts_as_tenant" {
  for_each           = local.tenant_keys
  service_account_id = "projects/${var.project_id}/serviceAccounts/${local.tenant_accounts[each.key]}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.orchestrator.email}"
  depends_on         = [google_service_account.tenant]
}

# The pack_secret_readers secrets listed for the tenant: a member on the
# secret's own policy, as the pack account's grant is.
resource "google_secret_manager_secret_iam_member" "tenant_reads_cloud_secrets" {
  for_each   = local.tenant_cloud_secrets
  secret_id  = each.value.secret
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${local.tenant_accounts[each.value.tenant]}"
  depends_on = [google_service_account.tenant]
}

# ---- what every tenant reaches ---------------------------------------------------

# The Cloud SQL instances the packs' code connects to, under one condition on
# the listed instances, the same for every tenant: the tenants are members of
# one binding. A change to the list is a new condition, which replaces each
# grant, so the new one is made before the old one goes.
resource "google_project_iam_member" "tenant_sql_client" {
  for_each = length(var.pack_cloud_sql_instances) > 0 ? local.tenant_keys : {}
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${local.tenant_accounts[each.key]}"

  condition {
    title       = "kindgi-pack-instances-only"
    description = "The Cloud SQL instances the pack services connect to (pack_cloud_sql_instances) only."
    expression = join(" || ", [
      for i in local.pack_sql_instances : "resource.name == \"projects/${i[0]}/instances/${i[1]}\"" if i != null
    ])
  }

  lifecycle {
    create_before_destroy = true
  }
  depends_on = [google_service_account.tenant]
}

resource "google_storage_bucket_iam_member" "tenant_reads" {
  for_each = {
    for pair in setproduct(var.pack_bucket_readers, keys(local.tenant_keys)) : "${pair[0]}|${pair[1]}" => {
      bucket = pair[0]
      tenant = pair[1]
    }
  }
  bucket = each.value.bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${local.tenant_accounts[each.value.tenant]}"

  # The pack account's prefixes, with its title, description and expression:
  # every tenant is a member of the same binding.
  dynamic "condition" {
    for_each = contains(keys(var.pack_bucket_object_prefixes), each.value.bucket) ? [1] : []
    content {
      title       = "pack-object-prefixes"
      description = "The pack reads only these prefixes."
      expression = join(" || ", [
        for prefix in var.pack_bucket_object_prefixes[each.value.bucket] :
        "resource.name.startsWith(\"projects/_/buckets/${each.value.bucket}/objects/${prefix}\")"
      ])
    }
  }
  depends_on = [google_service_account.tenant]
}

resource "google_cloud_run_v2_service_iam_member" "tenant_invokes" {
  for_each = {
    for pair in setproduct(var.pack_run_invokers, keys(local.tenant_keys)) :
    "${pair[0].project}/${pair[0].location}/${pair[0].service}|${pair[1]}" => {
      service = pair[0]
      tenant  = pair[1]
    }
  }
  project    = each.value.service.project
  location   = each.value.service.location
  name       = each.value.service.service
  role       = "roles/run.invoker"
  member     = "serviceAccount:${local.tenant_accounts[each.value.tenant]}"
  depends_on = [google_service_account.tenant]
}
