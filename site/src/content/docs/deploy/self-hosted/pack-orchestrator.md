---
title: Run a pack service for each deployment on Cloud Run
description: Give each deployment its own Cloud Run pack service with kindgi-runtime packs orchestrate. What one pass does, its settings, what its account calls, and what every pack service shares.
sidebar:
  order: 3.95
---

With per-deployment routing (`KINDGI_PACK_ROUTING=per-deployment`), the
runtime records where each deployment's pack service runs and checks it, but
never makes or deletes one. `kindgi-runtime packs orchestrate` does that on
Cloud Run (runtime 0.4.0 or later). It runs one pass, then exits. Run it from
the runtime image as a Cloud Run Job, once a minute. It serves a runtime of
one tenant or [many](../serve-many-tenants/), and does what
[A pack service for each deployment](../serve-many-tenants/#a-pack-service-for-each-deployment)
describes by hand.

## Before you start

- **The runtime, routing per deployment:** `KINDGI_PACK_ROUTING=per-deployment`,
  `KINDGI_PACK_ENDPOINT_HOSTS = "*-<project number>.<region>.run.app"`, and
  [`KINDGI_PACK_ENDPOINT_KMS_KEY`](../../../reference/env-vars/#kindgi_pack_endpoint_kms_key)
  (or the `postgres` secrets backend) to seal each endpoint's token.
- **A system key** holding `system:deployments` and `system:pack-env`
  ([The operator's keys](../serve-many-tenants/#the-operators-keys)). It
  reaches only the routes the orchestrator calls.
- **Two service accounts in the project:** the Job's own, and one that every
  pack service runs as.
- **The runtime's account may invoke the project's Cloud Run services**
  (`roles/run.invoker` on the project): it calls each pack service with a
  Google ID token. The orchestrator never sets a service's own policy, and
  won't use a service that has one.

## What one pass does

1. **Claims the round.** One pass runs at a time. One that starts while
   another holds the round exits at once, doing nothing.
2. **Finishes what a stopped pass left:** a retirement it began, and secrets
   whose service is gone.
3. **Retires what should go.** It clears each one's endpoint, deletes the
   secrets that are its own, then deletes its service.
4. **Makes a service for each deployment that needs one.** The service is
   named after the deployment (`kp-` and 20 characters), runs its image as the
   pack service account, and gets a token of its own. Each value its pack
   declares is either given as a plain environment variable or kept as a
   secret of its own, read at a pinned version. Then its endpoint is recorded.
   A deployment it can't serve gets a problem that its tenant sees, and is
   tried again: every pass for ten minutes, then every ten minutes for a day,
   then hourly.
5. **Gives running services their changed values.** Each new secret value is
   a new version. Once the new revision serves, the old versions are
   destroyed.
6. **Ends the round.**

Each pass stops sending anything a minute before its round ends. What it
didn't reach, the next pass does.

## Its settings

| Variable | |
| --- | --- |
| `KINDGI_ORCHESTRATOR_RUNTIME_URL` | The runtime, as the Job reaches it: `https`, or `http` on loopback only. |
| `KINDGI_ORCHESTRATOR_SYSTEM_KEY` | The system key, from a secret. |
| `KINDGI_ORCHESTRATOR_PROJECT` | The project the pack services run in. |
| `KINDGI_ORCHESTRATOR_REGION` | Their region, such as `us-central1`. |
| `KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT` | The account every pack service runs as. |
| `KINDGI_ORCHESTRATOR_PACK_SERVICE` | How each runs, as JSON. Optional. |

```json
{
  "ingress": "internal",
  "egress": { "kind": "connector", "connector": "projects/acme-kindgi/locations/us-central1/connectors/packs" },
  "cpu": "1",
  "memory": "1Gi",
  "maxInstances": 8,
  "concurrency": 32,
  "timeoutSeconds": 300,
  "cloudSqlInstances": ["acme-kindgi:us-central1:kindgi"]
}
```

Every field is optional. `egress` is `subnet` (with `subnetwork` and
`networkTags`), `connector` or `none` (the default). The
[environment variables reference](../../../reference/env-vars/) lists each
field and its default. A setting that's missing or wrong stops the pass
before it calls anything, naming the setting but never its value.

## What its account calls

- **Cloud Run:** creates, reads, updates, lists and deletes the project's
  services. It acts as the pack service account (`iam.serviceAccounts.actAs`
  on that account alone). It never sets an IAM policy.
- **Secret Manager:** creates secrets and their versions, destroys versions,
  and deletes secrets, all named `kp-…`. It also lists the project's secrets,
  names and labels only, to find the ones a stopped pass left. It never reads
  a value. The values come from the runtime.

Grant the pack service account
`roles/secretmanager.secretAccessor` on the `kp-` secrets alone, with the
condition `resource.name.startsWith("projects/<project number>/secrets/kp-")`.
Give no other secret a name that begins with `kp-`.

## What every pack service shares

Every pack service runs as the one pack service account. Whatever one of
them may read, every one may, each other's secrets and tokens included. A
service is kept apart from the others by the runtime's routing, not by
Google Cloud's permissions. Give that account only what every pack may use.
Packs that mustn't share secrets need installations of their own.

## Exit codes and logs

- **0:** the pass ran, or another pass held the round. Failures are logged,
  and a deployment's is recorded with the runtime, so its tenant sees why.
- **1:** the pass couldn't run: the runtime unreachable, the key refused, or
  the routes missing (is `KINDGI_PACK_ROUTING=per-deployment` set on the
  server?).
- **2:** a setting is missing or wrong.

Each pass ends with one line: what it made, retired and gave, and what
failed. Its logs carry `subsystem: pack-orchestrator`
([Logs](../logs/)).

## What a tenant sees

A deployment waiting for its service shows `pending` with a problem code
(`kindgi deploy` waits on it and prints it). Besides the codes in
[step 4](../serve-many-tenants/#a-pack-service-for-each-deployment), the
orchestrator records:

- `pack-env-name-too-long`: a name set as a secret is too long to name a
  secret after its service. Shorten it in the pack.
- `pack-env-secret-too-large`: a secret value over 32768 bytes.
