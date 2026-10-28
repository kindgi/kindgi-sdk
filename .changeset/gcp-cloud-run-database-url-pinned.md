---
"@kindgi/sdk": patch
---

**The Cloud Run module pins the server's database URL (breaking): `database_url_secret_version` is required.** `KINDGI_DATABASE_URL` reads that version of `<prefix>-database-url` (or of `database_instance.url_secret`), never `latest`, so a version added later reaches no revision until an apply sets it. Going back from an upgrade, the URL to a fresh database then moves the server in the same apply as its old image, and no instance of the newer version reaches that database first. A var-file without it stops at `terraform plan`, with a message that names the command printing the version the server reads. Rotating the URL is now: add a version, set `database_url_secret_version` to it, and apply. `upgrade.sh`'s checks read that version too, and the way back it prints sets it.

**Upgrade step, for a Cloud Run deployment of the module:** `upgrade.sh` adds `database_url_secret_version` to your var-file in the upgrade's own apply, set to the version of the URL the server reads today (it reads that version's number, never its value). Upgrading by hand, add it before you plan, set to that version: `gcloud secrets versions describe latest --secret=<prefix>-database-url --format='value(name.basename())'` prints it.
