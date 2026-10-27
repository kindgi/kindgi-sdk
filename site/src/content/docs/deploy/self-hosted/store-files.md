---
title: Choose where the runtime keeps files
description: Keep artifacts, the erasure ledger's copies and purge records in a directory, a Google Cloud Storage bucket, or an AWS S3 bucket or S3-compatible store, with the permissions each needs and what the runtime checks before it serves.
sidebar:
  order: 3.85
---

When you finish this page, a self-hosted runtime keeps its files where you
choose: in a directory on its machine, in a Google Cloud Storage bucket, or
in an S3 bucket, on AWS or in an S3-compatible store such as MinIO or
Cloudflare R2. Before it serves, it checks that it can use each one.

## Before you start

- **A runtime you deploy yourself,** whose settings you can change
  ([Self-host Kindgi](../self-host/)).
- **For `s3:`, and the startup checks on this page, runtime 0.3.0 or
  later.** An earlier runtime refuses `s3:` at startup.
- **For a bucket, the server's own identity** with access to it: its AWS
  identity, its Google service account, or an S3-compatible store's own key.

## Where files go

These settings and flags each name a place:

| Setting or flag | What goes there |
| --- | --- |
| `KINDGI_ARTIFACTS` | Artifacts' bytes ([Keep files with a run](../../../guides/runs/keep-files-with-a-run/)). Unset, the runtime serves no artifacts |
| `KINDGI_ERASURE_LEDGER_EXPORT` | The server's copies of the erasure ledger ([Back up and restore](../back-up-and-restore/#copies-the-runtime-keeps-on-its-own)) |
| `KINDGI_TENANT_PURGE_RECORD` | Purge records, from a purge through the system API ([Serve many tenants](../serve-many-tenants/#close-and-purge-a-tenant)) |
| `tenants purge --record` | Purge records, from the command |
| `tenants repurge --from`, `--ledger` | Where it reads the records, and the ledger's copies |
| `erasures export --out` | One copy of the ledger, written when you run it |
| `erasures replay --from` | Where it reads the ledger's copies. It also takes one file by its absolute path |

A place has one of three forms:

```text
local:<absolute dir>       a directory on the runtime's machine
gcs:<bucket>[/<prefix>]    a Google Cloud Storage bucket
s3:<bucket>[/<prefix>]     an S3 bucket, on AWS or in an S3-compatible store
```

- **A directory** suits one server with a disk that lasts. More than one
  replica, or a disk that doesn't last, such as Cloud Run's, needs a bucket.
- **A prefix** keeps a setting's files apart in a shared bucket. Artifacts
  go under `tenants/<tenant id>/` in the bucket, then the prefix:
  `s3:acme-artifacts/prod` puts them under `tenants/<tenant id>/prod/`. The
  ledger's copies go under the prefix itself, and purge records under
  `<prefix>/purged/`.
  `gcs://` and `s3://` work too, and a trailing `/` is dropped.

The `kindgi-runtime tenants` and `erasures` commands read the server's own
settings, and check the artifacts bucket, and a bucket they write to, as the
server does at startup.

A malformed value stops the runtime at startup, with exit code 2, as every
startup refusal on this page does:

```text
KINDGI_ARTIFACTS must be `local:<absolute dir>`, `gcs:<bucket>[/<prefix>]` or `s3:<bucket>[/<prefix>]`; the directory must be absolute. Got "local:artifacts".
```

The startup output says where artifacts go, or that they're off:

```text
  Artifacts: off (KINDGI_ARTIFACTS=local:<dir>, gcs:<bucket> or s3:<bucket> turns on /v1/artifacts)
  Artifacts: on, files under /var/lib/kindgi/artifacts
```

## A directory

```sh
KINDGI_ARTIFACTS=local:/var/lib/kindgi/artifacts
```

- **Before it serves,** the runtime makes each `local:` directory if it's
  missing, writes a file there, `.kindgi-write-probe`, and removes it. A
  ledger or records directory it makes is the server's alone (mode 0700).
- **In the runtime's image,** the server runs as the user `kindgi`, uid
  10001, and `/var/lib/kindgi/artifacts` is its. An empty Docker named
  volume mounted there takes that owner: add
  `-v kindgi-artifacts:/var/lib/kindgi/artifacts` to the server's
  `docker run`. A directory you bind-mount from the host must be the
  server's: `chown 10001` it on the host.

A directory the server can't write in stops it at startup:

```text
KINDGI_ARTIFACTS: the server (uid 10001) can't write in /var/lib/kindgi/artifacts: EACCES: permission denied, …. Give it the directory (chown 10001 /var/lib/kindgi/artifacts), or name another.
```

## AWS S3

```sh
KINDGI_ARTIFACTS=s3:acme-artifacts/prod
KINDGI_S3_REGION=eu-west-1
KINDGI_AWS_IDENTITY=instance    # or container, or web-identity
```

- **The region:** `KINDGI_S3_REGION`, the region of the server's buckets,
  one for every `s3:` target, in AWS's commercial, GovCloud or China
  partition. Any `s3:` target needs it, and so does any other
  `KINDGI_S3_*` setting.
- **The identity:** S3 signs in as the server's own AWS identity,
  [`KINDGI_AWS_IDENTITY`](../../../reference/env-vars/#kindgi_aws_identity),
  as [AWS Secrets Manager](../secret-manager/#aws-secrets-manager) does:
  `container`, `instance`, `web-identity`, or `profile` in development.
  `KINDGI_AWS_ROLE_ARN` has it assume a role on top.
- **What it ignores:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and the
  rest of the AWS SDK's default chain. It sends no request to
  `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` or a profile's `endpoint_url`.
- **Bucket names with a dot** are refused on AWS: a request puts the bucket
  in the host name, where TLS can't cover the dot. An S3-compatible store
  takes one with path style.
- **Unfinished uploads:** a failed upload is aborted, leaving no parts. One
  the server can't finish, because it stopped, leaves its parts until a
  lifecycle rule aborts them, or its tenant is purged. Add a rule with
  `AbortIncompleteMultipartUpload` after 1 day, for the whole bucket or for
  keys under `tenants/`.

The IAM actions the identity needs on each bucket:

| The bucket holds | IAM actions |
| --- | --- |
| Artifacts (`KINDGI_ARTIFACTS`) | `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload`, `s3:ListBucketMultipartUploads` and `s3:ListBucket`. Without `s3:ListBucket`, S3 answers 403 for a missing key. A prefix condition may narrow it |
| Artifacts, read at startup | `s3:GetBucketVersioning`, `s3:GetBucketObjectLockConfiguration` and `s3:GetLifecycleConfiguration` |
| Artifacts, with versioning on or suspended | Also `s3:ListBucketVersions` and `s3:DeleteObjectVersion` |
| Artifacts, with Object Lock | Also `s3:GetObjectRetention` and `s3:GetObjectLegalHold`, so a refused delete names the lock |
| Artifacts, with SSE-KMS | Also `kms:GenerateDataKey` and `kms:Decrypt` on the key |
| [Files written once](#files-written-once), and reading them back | `s3:PutObject`, `s3:GetObject` and `s3:ListBucket` |

Before it serves, the runtime checks the artifacts bucket: that it's in
`KINDGI_S3_REGION`, that a tenant purge could delete everything in it, and
that it may list what a delete lists: unfinished uploads, and versions in a
bucket that keeps them. It doesn't start without
a way to sign in or a region, or when a check fails:

```text
S3 signs in as the server's AWS identity: set KINDGI_AWS_IDENTITY.
KINDGI_ARTIFACTS=s3:… needs KINDGI_S3_REGION: the region of its bucket.
KINDGI_ARTIFACTS: bucket acme-artifacts is in us-east-1, KINDGI_S3_REGION is eu-west-1.
KINDGI_ARTIFACTS: S3 ListMultipartUploads on bucket acme-artifacts was refused (…): every delete needs s3:ListBucketMultipartUploads (region eu-west-1).
KINDGI_ARTIFACTS: bucket acme-artifacts has MFA Delete on, so no tenant purge could delete its versions. Turn MFA Delete off, or use another bucket.
KINDGI_ARTIFACTS: bucket acme-artifacts has an Object Lock default retention (COMPLIANCE, 30 days), which locks every upload, so no tenant purge could delete one. Remove the default retention, or use another bucket; Object Lock with no default retention is fine.
```

The startup output names the bucket and its region, `versioned` when
versioning is on or suspended, and warns when no rule aborts unfinished
uploads:

```text
  Artifacts: on, S3 bucket acme-artifacts/prod in eu-west-1, versioned
  ⚠ Artifacts: no lifecycle rule on bucket acme-artifacts aborts unfinished uploads, so an interrupted upload's parts stay until its tenant is purged. Add one (AbortIncompleteMultipartUpload, 1 day).
```

## An S3-compatible store

```sh
KINDGI_ARTIFACTS=s3:acme-artifacts
KINDGI_S3_REGION=us-east-1    # auto for R2
KINDGI_S3_ENDPOINT=https://minio.example.com
KINDGI_S3_PATH_STYLE=true
KINDGI_S3_CREDENTIALS_PATH=/run/secrets/s3-keys.json
```

- **The address:** `KINDGI_S3_ENDPOINT`, the store's `https://` address,
  with no path, user, query or fragment. Plain `http://` works only in
  development (`KINDGI_DEV=true`). Unset, it's AWS S3.
- **The region:** a region name the store takes: `auto` for R2,
  `us-east-1` for MinIO.
- **Path style:** `KINDGI_S3_PATH_STYLE=true` names the bucket in the
  request's path (`<endpoint>/<bucket>/<key>`), not in its host name, for a
  store that needs it. It's `true` or `false`, and `false` by default. A
  bucket name with a dot needs it.
- **The key:** `KINDGI_S3_CREDENTIALS_PATH`, the absolute path of a JSON
  file with the store's own access key, mounted into the container:

  ```json
  {"accessKeyId": "…", "secretAccessKey": "…"}
  ```

  The runtime reads it again whenever the file changes, so a rotated key is
  used from the next request on. An error names the file, never what's in
  it. Without a key file, S3 signs in as the server's AWS identity
  (`KINDGI_AWS_IDENTITY`). It ignores what it ignores on AWS.
- **What a store doesn't have:** a store that answers "not implemented" to
  a bucket-settings call, or to listing unfinished uploads, is taken to have
  none of it. R2, for example, has no versioning, and the runtime can't see
  its bucket locks at start, since they're set through Cloudflare rather than
  S3's Object Lock: keep them off the artifacts bucket, where a locked file
  stops a purge. On the ledger's and the records' buckets they're fine.
  Checksums are sent only where the store requires them.
- **Unfinished uploads:** On MinIO a purge leaves an interrupted upload's
  parts until MinIO's own expiry, 24 h by default (`stale_uploads_expiry`),
  and they can't be read through the runtime in that time. Add a rule that
  aborts unfinished uploads if the store takes one.

It doesn't start when these settings don't fit, or the key file isn't that
shape. Path style and the key file need `KINDGI_S3_ENDPOINT`:

```text
KINDGI_S3_ENDPOINT must be the store's https:// address, with no path, user, query or fragment. Got "http://minio.example.com:9000".
KINDGI_S3_ENDPOINT must not carry a user or password: the store's key goes in KINDGI_S3_CREDENTIALS_PATH.
S3 at KINDGI_S3_ENDPOINT needs a way in: KINDGI_S3_CREDENTIALS_PATH (the store's own key), or KINDGI_AWS_IDENTITY (the server's AWS identity).
KINDGI_S3_PATH_STYLE is for an S3-compatible store: it needs KINDGI_S3_ENDPOINT.
KINDGI_S3_CREDENTIALS_PATH (/run/secrets/s3-keys.json) must be JSON with a non-empty accessKeyId and secretAccessKey.
```

The startup output names the store's host, and warns as on AWS, with the
store's own expiry:

```text
  Artifacts: on, S3 bucket acme-artifacts in us-east-1, at minio.example.com
  ⚠ Artifacts: no lifecycle rule on bucket acme-artifacts aborts unfinished uploads, so an interrupted upload's parts can stay until the store's own expiry removes them (on MinIO, stale_uploads_expiry: 24 h by default). Add one if the store takes it (AbortIncompleteMultipartUpload, 1 day).
```

## Google Cloud Storage

```sh
KINDGI_ARTIFACTS=gcs:acme-artifacts
```

- **The identity:** the server's Application Default Credentials. On Google
  Cloud, that's the service account of its VM or workload, with no key to
  store.
- **Refused:** an artifacts bucket with a retention policy, or a default
  event-based hold, since no tenant purge could delete what's in it.
- **Warned:** a soft delete, which keeps a deleted file restorable for its
  period (Google turns it on for 7 days by default), and a lifecycle rule
  that can delete a live file under `tenants/`. Versioning is fine.
- **The emulator:** `STORAGE_EMULATOR_HOST` sends every GCS request to that
  host, with no credentials, so it's for development only. Outside
  `KINDGI_DEV=true`, the runtime doesn't start with it and a `gcs:`
  setting, and a command refuses its own `gcs:` `--from` or `--out` the
  same way.

The permissions the identity needs, granted on each bucket:

| The bucket holds | Permissions | Roles |
| --- | --- | --- |
| Artifacts (`KINDGI_ARTIFACTS`) | `storage.objects.create`, `storage.objects.get`, `storage.objects.list` and `storage.objects.delete`, and `storage.buckets.get` to read the bucket's settings at startup | `roles/storage.objectAdmin` grants the first four. It lacks `storage.buckets.get`, so add `roles/storage.legacyBucketReader` on the bucket, or use a custom role |
| [Files written once](#files-written-once) | `storage.objects.create` | `roles/storage.objectCreator` |
| Reading them back | Also `storage.objects.get` and `storage.objects.list` | `roles/storage.objectViewer` |

Before it serves, the runtime checks the artifacts bucket's five permissions
and reads its settings. It doesn't start when a check fails:

```text
KINDGI_ARTIFACTS: there's no GCS bucket acme-artifacts, or the server's identity can't see it.
KINDGI_ARTIFACTS: bucket acme-artifacts: the server's identity lacks storage.buckets.get. The boot check needs storage.buckets.get to read the bucket's settings: grant it on the bucket, for example with roles/storage.legacyBucketReader or a custom role.
KINDGI_ERASURE_LEDGER_EXPORT: bucket acme-erasure-ledger: the server's identity lacks storage.objects.create, which writing there needs. Grant it on the bucket, for example with roles/storage.objectCreator.
KINDGI_ARTIFACTS: bucket acme-artifacts has a retention policy of 30 days, which keeps every file that long, so no tenant purge could delete one. Remove the retention policy, or use another bucket.
KINDGI_ARTIFACTS: bucket acme-artifacts has a default event-based hold, which holds every new file until someone releases it, so no tenant purge could delete one. Turn the default event-based hold off, or use another bucket.
KINDGI_ARTIFACTS=gcs:acme-artifacts: STORAGE_EMULATOR_HOST is set (localhost:4443), so every GCS request would go to that host, with no credentials. It's for tests and development (KINDGI_DEV=true): unset it.
```

The startup output names the bucket, and warns of each setting that keeps
or deletes files on its own:

```text
  Artifacts: on, GCS bucket acme-artifacts, versioned
  ⚠ Artifacts: deleted files stay restorable in bucket acme-artifacts for 7 days (its soft delete). Set the bucket's soft delete to 0 to make deletes final.
  ⚠ Artifacts: a lifecycle rule on bucket acme-artifacts (Delete when age 30) can delete files the runtime still names. Limit it to noncurrent versions, or to other keys than tenants/.
```

## Files written once

The erasure ledger's copies and purge records are written once, and never
overwritten or deleted: `KINDGI_ERASURE_LEDGER_EXPORT`,
`KINDGI_TENANT_PURGE_RECORD`, `tenants purge --record` and
`erasures export --out`.

- **Before it serves,** the runtime checks each of them: a directory takes
  a write, and a `gcs:` bucket must let it create files. An `s3:` bucket
  must be in its region and honor a conditional write (`If-None-Match`): the
  runtime writes `.kindgi-conditional-write-probe` under the prefix, and
  when that write made the file, writes it again, which must be refused. The
  file stays there.
- **Retention on these buckets is fine:** the runtime only adds files.
  Keep the ledger's copies longer than your backups. If a bucket's rule
  deletes a purge record, the ledger's copy still names the tenant
  ([`tenants repurge --ledger`](../serve-many-tenants/#after-a-restore-tenants-repurge)).
  Reading them back needs read access too, as the tables above say.

A store that overwrites the probe is refused, since a copy or a record
could be lost:

```text
KINDGI_ERASURE_LEDGER_EXPORT: the store https://minio.example.com ignores If-None-Match: a second create-once write of acme-erasure-ledger/runtime/.kindgi-conditional-write-probe overwrote it, so an erasure ledger or purge record could be overwritten. Use a store that honors conditional writes.
```

The startup output says where the ledger's copies go. Purge records have no
line:

```text
  Erasure ledger: copied every 1 h to s3:acme-erasure-ledger/runtime, every tenant's, for a replay after a restore
```

## What a delete does

The runtime deletes an artifact's bytes when a
[retention policy](../../retention/) purges the deleted artifact, and when
its tenant is
[purged](../serve-many-tenants/#close-and-purge-a-tenant). Each delete goes
as far as the bucket allows:

- **A directory:** the file is removed.
- **S3:** it aborts the file's unfinished uploads, deletes the file, and in
  a bucket with versioning on or suspended, deletes every version and
  delete marker of it. It checks on each delete, since versioning can be
  turned on at any time.
- **GCS:** it deletes every generation of the file by its number, so a
  versioned bucket keeps no noncurrent copy. A soft delete still keeps them
  restorable for its period: set it to 0 to make deletes final.

A tenant purge also deletes what no row names under the tenant's keys for
the artifacts setting (`tenants/<tenant id>/<prefix>/`), such as an upload
whose row was never written. On AWS S3, that includes unfinished uploads. On MinIO a purge leaves an interrupted upload's parts
until MinIO's own expiry, 24 h by default (`stale_uploads_expiry`), and they
can't be read through the runtime in that time.

A file under an S3 Object Lock retention or legal hold, or under a GCS
retention time or hold, isn't deleted, and the purge stops there.
`kindgi-runtime tenants purge` exits 2 with
`tenants purge: an artifact's bytes couldn't be deleted:` and the reason,
the lock or the permission the server lacks:

```text
acme-artifacts/<key> is locked by S3 Object Lock: a retention until 2027-01-31T00:00:00.000Z and a legal hold
S3 refused deleting a version of acme-artifacts/<key>, which has no retention or legal hold: on a versioned bucket the server needs s3:DeleteObjectVersion
```

On GCS it's `locked by GCS:`, with the retention's end and each hold.
Release the lock, or wait for it to end, then run the purge again.

## Next

- [The environment variable reference](../../../reference/env-vars/#kindgi_artifacts):
  every setting on this page.
- [Back up and restore](../back-up-and-restore/): the erasure ledger's
  copies, and replaying them after a restore.
