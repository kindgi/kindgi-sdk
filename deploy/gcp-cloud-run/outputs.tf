# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

output "server_url" {
  description = "The Kindgi API (and /console)."
  value       = google_cloud_run_v2_service.server.uri
}

output "pack_service_url" {
  description = "The pack service's internal URL (the server's KINDGI_PACK_SERVICE_URL)."
  value       = google_cloud_run_v2_service.pack.uri
}

output "database_private_ip" {
  description = "Private-IP mode: the address in KINDGI_DATABASE_URL (postgres://<user>:<password>@<this>:5432/<db>?sslmode=require); null otherwise."
  value       = local.database_private ? google_sql_database_instance.kindgi.private_ip_address : null
}

output "sql_connection_name" {
  description = "For the database URL: postgres://<user>:<password>@/<db>?host=/cloudsql/<this>."
  value       = google_sql_database_instance.kindgi.connection_name
}

output "image_repository" {
  description = "Where the runtime and pack images go."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "secrets_to_fill" {
  description = "The secrets the operator adds a version to before the first deploy (README, step 3)."
  value = sort(concat(
    [for s in google_secret_manager_secret.server : s.secret_id],
    [for s in google_secret_manager_secret.shared : s.secret_id],
  ))
}

output "service_accounts" {
  value = {
    server = google_service_account.server.email
    pack   = google_service_account.pack.email
  }
}

output "nat_ip" {
  description = "The static egress address (nat_static_ip = true), for allowlists; null when Google picks it."
  value       = local.direct && var.nat_static_ip ? google_compute_address.nat[0].address : null
}
