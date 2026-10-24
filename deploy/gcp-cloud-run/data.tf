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
# Cloud SQL connector Cloud Run mounts at /cloudsql (which checks IAM, and
# encrypts the connection and verifies the instance itself), or private IP
# only on an existing VPC (database_private_network), reached over TCP
# through the services' VPC egress. ENCRYPTED_ONLY either way. Over TCP
# the URL says sslmode=require, which encrypts and checks no certificate,
# and the private IP isn't in the server certificate, so the server checks
# its certificate against the instance's own CAs (KINDGI_DATABASE_SERVER_CA,
# read from runtime 0.2.0 on): the chain and the dates, not the name.
# That's enough with the per-instance CA the instance gets by default,
# which signs this one instance's certificate alone.

locals {
  database_private = var.database_private_network != ""
  # Private-IP mode: the CAs the server's certificate must chain to.
  database_server_ca = (length(data.google_sql_ca_certs.kindgi) > 0
    ? join("\n", [for ca in data.google_sql_ca_certs.kindgi[0].certs : trimspace(ca.cert)])
  : "")
}

resource "google_sql_database_instance" "kindgi" {
  count               = var.database_host_instance == null ? 1 : 0
  name                = var.name_prefix
  region              = var.region
  database_version    = var.database_version
  deletion_protection = var.database_deletion_protection
  depends_on          = [google_project_service.apis]

  lifecycle {
    # Cloud SQL keeps at most 7 days of transaction logs on ENTERPRISE: refused at
    # plan, not halfway through an apply. A precondition, since a variable's own
    # validation can't read another before Terraform 1.9.
    precondition {
      condition     = var.database_point_in_time_days == null ? true : var.database_point_in_time_days <= (var.database_edition == "ENTERPRISE_PLUS" ? 35 : 7)
      error_message = "database_point_in_time_days is at most 7 on ENTERPRISE (35 on ENTERPRISE_PLUS)."
    }
    # Cloud SQL keeps no more days of logs than backups: "The transaction log
    # retention setting must always be less than or equal to the backup
    # retention setting". Unset, each is Cloud SQL's default for the edition.
    precondition {
      condition = (
        coalesce(var.database_point_in_time_days, var.database_edition == "ENTERPRISE_PLUS" ? 14 : 7)
        <= coalesce(var.database_backup_retention, var.database_edition == "ENTERPRISE_PLUS" ? 15 : 7)
      )
      error_message = "database_point_in_time_days is more than the backups kept (database_backup_retention; unset, 7 on ENTERPRISE and 15 on ENTERPRISE_PLUS, with 7 and 14 days of logs): Cloud SQL keeps at most as many days of logs as backups. Google recommends one backup more than days of logs."
    }
  }

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
      # Unset unless a variable says otherwise: Cloud SQL's own defaults.
      location                       = var.database_backup_location
      transaction_log_retention_days = var.database_point_in_time_days

      dynamic "backup_retention_settings" {
        for_each = var.database_backup_retention == null ? [] : [var.database_backup_retention]
        content {
          retained_backups = backup_retention_settings.value
          retention_unit   = "COUNT"
        }
      }
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    # A backstop for every session on the instance; the server's own
    # connections set a shorter one of their own.
    database_flags {
      name  = "idle_in_transaction_session_timeout"
      value = tostring(var.database_idle_in_transaction_timeout_ms)
    }
  }
}

# Private-IP mode: every CA the instance trusts (the one in use, one added
# for a rotation, one rotated out), read at each plan, so a CA added before
# a rotation reaches the server at the next apply. Private-IP mode serves
# from the module's own instance alone: database_instance and
# database_host_instance are reached through /cloudsql, and services.tf
# refuses either with private-IP mode. With database_host_instance set
# there's no instance here to read.
data "google_sql_ca_certs" "kindgi" {
  count    = local.database_private ? length(google_sql_database_instance.kindgi) : 0
  instance = google_sql_database_instance.kindgi[count.index].name

  lifecycle {
    postcondition {
      condition     = length(self.certs) > 0
      error_message = "The instance lists no server CA: the server would have nothing to check the database's certificate against."
    }
  }
}

# The instance the server serves from when it isn't the module's own
# (database_instance): read, never managed here.
data "google_sql_database_instance" "served" {
  count = var.database_instance == null ? 0 : 1
  name  = var.database_instance.name

  lifecycle {
    # The server reaches it through Cloud Run's /cloudsql volume, as it does
    # the module's own instance in public-IP mode.
    postcondition {
      condition     = try(self.settings[0].ip_configuration[0].ipv4_enabled, false)
      error_message = "database_instance names ${self.name}, which has no public IP: the server reaches its instance through the /cloudsql volume, which needs one."
    }
  }
}

# Kindgi's database and user live on this existing instance when
# database_host_instance is set (the module makes no instance of its own):
# read, never managed here.
data "google_sql_database_instance" "host" {
  count = var.database_host_instance == null ? 0 : 1
  name  = var.database_host_instance

  lifecycle {
    # A host's backups are the app's, set where that instance is managed. The
    # module makes no instance here to set them on, so a backup variable given
    # with a host would be dropped without a word: a promise of where backups
    # are kept, broken at the apply that said it.
    precondition {
      condition     = var.database_backup_retention == null && var.database_backup_location == null && var.database_point_in_time_days == null
      error_message = "database_host_instance names ${var.database_host_instance}, whose backups are set where that instance is managed: leave database_backup_retention, database_backup_location and database_point_in_time_days unset."
    }
    # Public IP: the server reaches it through Cloud Run's /cloudsql volume.
    postcondition {
      condition     = try(self.settings[0].ip_configuration[0].ipv4_enabled, false)
      error_message = "database_host_instance names ${self.name}, which has no public IP: the server reaches its instance through the /cloudsql volume, which needs one."
    }
    # Postgres 16 or later keeps Kindgi's and the app's databases apart by
    # their role rules: before 16, CREATEROLE — which Kindgi's user needs —
    # could grant itself any other user's role.
    postcondition {
      condition     = can(regex("^POSTGRES_(1[6-9]|[2-9][0-9])$", self.database_version))
      error_message = "database_host_instance names ${self.name}, which runs ${self.database_version}: Kindgi shares an instance only with Postgres 16 or later, whose role rules keep the databases apart."
    }
  }
}

resource "google_sql_database" "kindgi" {
  name = var.database_name
  # A host's name from its read, not from the variable: README's first apply
  # targets this database, so the host is read in that apply too. Its checks
  # run there, and sql_connection_name is in the state for step 3.
  instance = var.database_host_instance != null ? data.google_sql_database_instance.host[0].name : google_sql_database_instance.kindgi[0].name

  # With a host instance the database lives on the app's own instance, so a
  # destroy or a database_name change must not drop it unless the operator
  # turned deletion protection off. Without a host it's the module's own
  # instance, deleted with it (DELETE, the provider default).
  deletion_policy = var.database_host_instance != null && var.database_deletion_protection ? "ABANDON" : "DELETE"
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
  # Only with the one pack service: under per-deployment routing each
  # endpoint carries its own token, and the server refuses this one.
  shared_secrets = local.pack ? {
    pack_service_token = "${var.name_prefix}-pack-service-token" # KINDGI_PACK_SERVICE_TOKEN, both services
  } : {}
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

# The server's own secret settings (var.server_secret_env, e.g. sign-in's):
# the operator created them; the server gets read access to exactly these.
# One in another project is granted there, not here (README).
resource "google_secret_manager_secret_iam_member" "server_reads_its_secrets" {
  for_each  = { for name, ref in var.server_secret_env : name => ref if ref.project == null }
  secret_id = "projects/${var.project_id}/secrets/${each.value.secret}"
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
  for_each  = { for name, secret in google_secret_manager_secret.shared : name => secret if local.pack }
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pack[0].email}"
}

# The pack's own secrets (`secret_env` from `kindgi env plan`): the
# operator created them; the pack service gets read access to exactly
# these. One in another project is granted there, not here (README).
resource "google_secret_manager_secret_iam_member" "pack_reads_its_secrets" {
  for_each  = { for name, ref in var.pack_secret_env : name => ref if local.pack && ref.project == null }
  secret_id = "projects/${var.project_id}/secrets/${each.value.secret}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pack[0].email}"
}
