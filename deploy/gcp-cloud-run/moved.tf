# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The pack account and its own grants exist while pack_shared_account is
# true, so they're counted. An installation from before keeps each: these
# moves give them their new addresses, so its plan shows no change. One
# whose account was still at pack[0] (it had the one pack service,
# pack_image) is at that address already.

moved {
  from = google_service_account.pack
  to   = google_service_account.pack[0]
}

moved {
  from = google_project_iam_member.pack_reads_pack_secrets
  to   = google_project_iam_member.pack_reads_pack_secrets[0]
}

moved {
  from = google_service_account_iam_member.orchestrator_acts_as_pack
  to   = google_service_account_iam_member.orchestrator_acts_as_pack[0]
}

# The module's own Cloud SQL instance became optional (database_host_instance:
# Kindgi's database lives on an existing instance instead). A deployment that
# makes its own keeps it; this move gives it its new address, so its plan
# shows no change.
moved {
  from = google_sql_database_instance.kindgi
  to   = google_sql_database_instance.kindgi[0]
}
