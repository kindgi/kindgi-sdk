# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

output "server_url" {
  description = "The Kindgi API (and /console)."
  value       = google_cloud_run_v2_service.server.uri
}

output "database_private_ip" {
  description = "Private-IP mode: the address in KINDGI_DATABASE_URL (postgres://<user>:<password>@<this>:5432/<db>?sslmode=require); null otherwise."
  value       = local.database_private && length(google_sql_database_instance.kindgi) > 0 ? google_sql_database_instance.kindgi[0].private_ip_address : null
}

output "sql_connection_name" {
  description = "For the database URL: postgres://<user>:<password>@/<db>?host=/cloudsql/<this>. With database_host_instance set, the host instance's connection name."
  value       = var.database_host_instance != null ? data.google_sql_database_instance.host[0].connection_name : google_sql_database_instance.kindgi[0].connection_name
}

output "image_repository" {
  description = "Where the runtime and pack images go."
  value = (local.own_repository
    ? "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images[0].repository_id}"
  : "${var.image_repository.location}-docker.pkg.dev/${var.image_repository.project}/${var.image_repository.repository}")
}

output "secrets_to_fill" {
  description = "The secrets the operator adds a version to before the first deploy (README, step 3)."
  value = sort(concat(
    [for s in google_secret_manager_secret.server : s.secret_id],
  ))
}

output "service_accounts" {
  description = "The server's, the one every pack service runs as, and the pack orchestrator's."
  value = {
    server       = google_service_account.server.email
    pack         = google_service_account.pack.email
    orchestrator = google_service_account.orchestrator.email
  }
}

output "orchestrator_key_steps" {
  description = "Until orchestrator_key_version is set, the steps that turn the pack orchestrator on (README, \"The pack orchestrator\"); null once it's set."
  value       = var.orchestrator_key_version != null ? null : <<-EOT
    The pack orchestrator is off: no deployment gets a pack service until it is on.
    1. Mint its system key with the deployment's own token, and keep it as the
       first version of ${google_secret_manager_secret.orchestrator_key.secret_id}${local.server_iam_guarded ? " (the server is behind Cloud Run IAM: your gcloud account needs roles/run.invoker on it)" : ""}:

       KEY=$(curl -sS -X POST "${google_cloud_run_v2_service.server.uri}/v1/system/keys" \${local.mint_id_token_header}
         -H @<(printf 'Authorization: Bearer %s\n' "$(gcloud secrets versions access latest --secret=${google_secret_manager_secret.server["api_token"].secret_id})") \
         -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
         -d '{"scopes": ["system:deployments", "system:pack-env"], "label": "pack orchestrator"}' \
         | jq -j '.token // error(.error.message)') && [ -n "$KEY" ] \
         && printf '%s' "$KEY" | gcloud secrets versions add ${google_secret_manager_secret.orchestrator_key.secret_id} --data-file=-
       unset KEY

       The version is added only if a key came back: a refused or failed call
       prints why and adds none.

    2. Set orchestrator_key_version to the version it printed ("1" the first
       time), and apply again: that makes the Job and its schedule.
    3. Deploy each pack again (kindgi deploy, the same image is enough, with
       --idempotency-key <new value> so it isn't answered as the earlier
       deploy was): a deployment from before this server routed per
       deployment has no routes until then.
  EOT
}

output "nat_ip" {
  description = "The static egress address (nat_static_ip = true), for allowlists; null when Google picks it."
  value       = local.direct && var.nat_static_ip ? google_compute_address.nat[0].address : null
}
