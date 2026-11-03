# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# Each deployment is a pack service of its own, made by the pack
# orchestrator, and every one runs as the pack account, which is no longer
# optional. A deployment that had the one pack service (pack_image) keeps
# its account: this move gives it its address back, so it isn't replaced.
# That pack service, the server's grant on it and its token's secret go.
# A deployment from before pack_image was optional never had the index.

moved {
  from = google_service_account.pack[0]
  to   = google_service_account.pack
}

# The module's own Cloud SQL instance became optional (database_host_instance:
# Kindgi's database lives on an existing instance instead). A deployment that
# makes its own keeps it; this move gives it its new address, so its plan
# shows no change.
moved {
  from = google_sql_database_instance.kindgi
  to   = google_sql_database_instance.kindgi[0]
}
