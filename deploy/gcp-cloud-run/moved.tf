# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

# The pack service, its account and the server's invoker grant became
# optional (pack_image unset: each deployment is a service of its own).
# A deployment that sets pack_image keeps the same resources: these moves
# give them their new addresses, so its plan shows no change.

moved {
  from = google_service_account.pack
  to   = google_service_account.pack[0]
}

moved {
  from = google_cloud_run_v2_service.pack
  to   = google_cloud_run_v2_service.pack[0]
}

moved {
  from = google_cloud_run_v2_service_iam_member.server_invokes_pack
  to   = google_cloud_run_v2_service_iam_member.server_invokes_pack[0]
}
