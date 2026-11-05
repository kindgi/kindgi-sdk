---
"@kindgi/cli": patch
---

**The Cloud Run module can renew the license key on a schedule, and both deploy modules' expiring alerts now follow the key's own warning window.**

- `deploy/gcp-cloud-run`:
  - With `license_renewal_schedule` (a cron line), the module adds a Cloud Run job on the runtime image that runs `kindgi license renew`, started by Cloud Scheduler. It runs as a service account of its own, which can read the license key and the renewer key and add versions to the license key, and nothing else. The job never restarts the server.
  - The module always creates the renewer key's secret, `<prefix>-license-renewer` or `license_renewer_secret`, empty; `kindgi license enroll` fills it once. The server gets `KINDGI_LICENSE_KEY_REF` and `KINDGI_LICENSE_RENEWER_REF`, so its expiry warning names the exact renew command. The outputs `license_enroll_command` and `license_renew_command` give both commands.
  - With `license_usage_key_secret` too (a secret holding a system key with `system:license` alone), the job renews with `--runtime` and `--runtime-token`: it sends counts of the deployment's use, and from runtime 0.7.0 it hands a renewed key to the running server, which uses it at once. Cloud Run IAM in front of the server would refuse those calls, so the module refuses this setting unless `server_public` or `server_invoker_iam_disabled` is true.
  - With the schedule, three Cloud Monitoring alerts, sent to `alert_notification_channels`: a run that failed, a key inside its warning window, and, with the usage key, a run that sent no counts. The schedule turns on the Monitoring API.
  - `upgrade.sh`'s plan check takes the renewal job's new image on an upgrade.
- `deploy/azure-container-apps`: with `license_usage_key_secret` and runtime 0.7.0 or later, a renewed key also reaches the running server at once.
- **The expiring alert's lead time changes, in both modules.** It used to fire when the key had under 7 days left. It now fires on any run inside the key's warning window, the same line `kindgi license renew` warns with: from 30 days before the key expires for a key that sets no warning, so much earlier than before, and from 5 days for a key that sets a warning of 5, so a little later.
