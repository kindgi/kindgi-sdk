# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# Kindgi's database and the secrets both services read.
#
# Secrets by reference: Terraform creates each secret's container and who
# may read it, never a value. The operator adds every value with
# `gcloud secrets versions add` (README), so no secret is in the
# Terraform state.

# ---- Cloud SQL ----------------------------------------------------------------
# Either public IP with no authorized networks, reachable only through the
# Cloud SQL connector Cloud Run mounts at /cloudsql (which checks IAM), or
# private IP only on an existing VPC (database_private_network), reached
# over TCP through the services' VPC egress. ENCRYPTED_ONLY either way:
# over TCP the URL says sslmode=require (postgres.js then speaks TLS; the
# private IP isn't in the server certificate, so it isn't verified).

locals {
  database_private = var.database_private_network != ""
}

resource "google_sql_database_instance" "kindgi" {
  name                = var.name_prefix
  region              = var.region
  database_version    = var.database_version
  deletion_protection = var.database_deletion_protection
  depends_on          = [google_project_service.apis]

  settings {
    edition           = var.database_edition
    tier              = var.database_tier
    availability_type = "ZONAL"

    ip_configuration {
      ipv4_enabled    = !local.database_private
      private_network = local.database_private ? var.database_private_network : null
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }
}

resource "google_sql_database" "kindgi" {
  name     = var.database_name
  instance = google_sql_database_instance.kindgi.name
}

# The database user and its password are created by the operator (README,
# step 3), so the password never passes through Terraform.

# ---- secrets ------------------------------------------------------------------

locals {
  # Secret containers, by role. Each value is added out of band.
  server_secrets = merge({
    database_url     = "${var.name_prefix}-database-url"     # postgres://…@/kindgi?host=/cloudsql/<connection name>, or …@<private ip>:5432/kindgi?sslmode=require
    api_token        = "${var.name_prefix}-api-token"        # KINDGI_API_TOKEN, the seeded bearer
    public_token_key = "${var.name_prefix}-public-token-key" # Ed25519 PKCS#8 PEM, base64: KINDGI_PUBLIC_TOKEN_SIGNING_KEY
    license_key      = "${var.name_prefix}-license-key"      # KINDGI_LICENSE_KEY (kgi_lk_…), issued by Kindgi
    }, local.kms ? {
    secrets_aad_key = "${var.name_prefix}-secrets-aad-key" # 32 random bytes, base64: KINDGI_SECRETS_AAD_KEY (secrets_backend = "postgres" only)
  } : {})
  shared_secrets = {
    pack_service_token = "${var.name_prefix}-pack-service-token" # KINDGI_PACK_SERVICE_TOKEN, both services
  }
}

resource "google_secret_manager_secret" "server" {
  for_each  = local.server_secrets
  secret_id = each.value

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "shared" {
  for_each  = local.shared_secrets
  secret_id = each.value

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "server_reads" {
  for_each  = merge(google_secret_manager_secret.server, google_secret_manager_secret.shared)
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.server.email}"
}

# ---- export signing (opt-in: var.export_signing) ----------------------------

# "secret": the key in Secret Manager. Its own container, created only
# when asked for, so a deployment that doesn't sign exports needs no
# secret version.
resource "google_secret_manager_secret" "export_signing_key" {
  count     = var.export_signing == "secret" ? 1 : 0
  secret_id = "${var.name_prefix}-export-signing-key" # Ed25519 PKCS#8 PEM, base64: KINDGI_EXPORT_SIGNING_KEY

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "server_reads_export_key" {
  count     = length(google_secret_manager_secret.export_signing_key)
  secret_id = google_secret_manager_secret.export_signing_key[count.index].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.server.email}"
}

# "kms": the server signs with the key version (asymmetricSign) and reads
# its public key at boot. IAM is on the version's crypto key.
locals {
  export_signing_crypto_key = try(regex("^(.*)/cryptoKeyVersions/[0-9]+$", var.export_signing_kms_key)[0], "")
}

resource "google_kms_crypto_key_iam_member" "server_signs_exports" {
  for_each      = var.export_signing == "kms" ? toset(["roles/cloudkms.signerVerifier", "roles/cloudkms.publicKeyViewer"]) : toset([])
  crypto_key_id = local.export_signing_crypto_key
  role          = each.value
  member        = "serviceAccount:${google_service_account.server.email}"
}

resource "google_secret_manager_secret_iam_member" "pack_reads_token" {
  for_each  = google_secret_manager_secret.shared
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pack.email}"
}

# The pack's own secrets (`secret_env` from `kindgi env plan`): the
# operator created them; the pack service gets read access to exactly
# these. One in another project is granted there, not here (README).
resource "google_secret_manager_secret_iam_member" "pack_reads_its_secrets" {
  for_each  = { for name, ref in var.pack_secret_env : name => ref if ref.project == null }
  secret_id = "projects/${var.project_id}/secrets/${each.value.secret}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pack.email}"
}
