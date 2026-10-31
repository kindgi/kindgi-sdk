---
title: Run a pack service for each deployment on Cloud Run
description: Give each deployment its own Cloud Run pack service with kindgi-runtime packs orchestrate. What one pass does, how to run it once a minute, its settings, the roles to grant, and what every pack service shares.
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

A round is held for ten minutes. In its last minute a pass sends nothing,
waits for nothing and starts nothing, so it has returned before another pass
can claim the round. A Cloud Run operation still running then is left: the
next pass finishes or replaces what it made. What a pass didn't reach, the
next one does.

## Running it once a minute

As a Cloud Run Job, from the runtime image, run by Cloud Scheduler:

```sh
gcloud run jobs create kindgi-pack-orchestrator --region=<region> \
  --image="<the runtime image>@sha256:<digest>" \
  --service-account=<the Job's account> \
  --args=packs,orchestrate --task-timeout=600s --max-retries=0 \
  --set-env-vars=KINDGI_ORCHESTRATOR_RUNTIME_URL=<runtime URL>,KINDGI_ORCHESTRATOR_PROJECT=<project>,KINDGI_ORCHESTRATOR_REGION=<region>,KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT=<pack service account> \
  --set-secrets=KINDGI_ORCHESTRATOR_SYSTEM_KEY=<system key secret>:latest
gcloud scheduler jobs create http kindgi-pack-orchestrator --location=<region> \
  --schedule="* * * * *" --http-method=POST \
  --uri="https://run.googleapis.com/v2/projects/<project>/locations/<region>/jobs/kindgi-pack-orchestrator:run" \
  --oauth-service-account-email=<an account that may run the Job>
```

- **The task timeout** is a backstop: a pass returns by itself before its
  round ends. Leave retries off: next minute's run is the retry.
- **The scheduler's account** needs `roles/run.invoker` on the Job.
- **Elsewhere:** cron or a systemd timer that runs
  `kindgi-runtime packs orchestrate` every minute works the same. Runs that
  overlap are fine: the round keeps one pass at a time.

## Its settings

| Variable | |
| --- | --- |
| `KINDGI_ORCHESTRATOR_RUNTIME_URL` | The runtime, as the Job reaches it: `https`, or `http` on loopback only. |
| `KINDGI_ORCHESTRATOR_SYSTEM_KEY` | The system key, from a secret. |
| `KINDGI_ORCHESTRATOR_PROJECT` | The project the pack services run in. |
| `KINDGI_ORCHESTRATOR_REGION` | Their region, such as `us-central1`. |
| `KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT` | The account every pack service runs as. |
| `KINDGI_ORCHESTRATOR_PACK_SERVICE` | How each runs, as JSON. Optional. |
| `KINDGI_ORCHESTRATOR_RUNTIME_AUTH` | `google-id-token` for a runtime behind Cloud Run IAM: each call also carries the orchestrator's own Google ID token (on Cloud Run, the Job's account's) for the runtime's URL, which must then be its `run.app` URL or one of its custom audiences, in `X-Serverless-Authorization`, beside the system key. Optional: unset, the key alone. |

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

## The roles to grant the Job's account

- **Cloud Run:** `roles/run.developer` on the project. It creates, reads,
  updates, lists and deletes the project's services, and reads a service's
  policy, but never sets one.
- **Acting as the pack service account:** `roles/iam.serviceAccountUser` on
  that account alone.
- **A runtime behind Cloud Run IAM:** `roles/run.invoker` on the runtime's
  service, so its calls, with the Job's ID token, pass Cloud Run's check
  (`KINDGI_ORCHESTRATOR_RUNTIME_AUTH=google-id-token`).
- **Secret Manager:** two custom roles on the project, or
  `roles/secretmanager.admin`, which grants more than it needs:
  - `secretmanager.secrets.get` and `.delete`, and
    `secretmanager.versions.add`, `.list` and `.destroy`, with the condition
    `resource.name.startsWith("projects/<project number>/secrets/kp-")`;
  - `secretmanager.secrets.create` and `.list`, with no condition: both name
    the project, not one secret, so a condition on the secret's name isn't
    sure to hold for them. A new secret holds no value until a version is
    added, and a list gives names and labels only, to find the secrets a
    stopped pass left.

  It works only on secrets named `kp-…`, and never reads a value: the values
  come from the runtime.

The Cloud Run role lets the account delete any service in the project. The
orchestrator touches a service only when its name is one it derives from a
deployment, its labels name that deployment, and it runs as the pack service
account. A secret that exists already is used only when its labels name the
deployment and it's held in the region alone. So run one installation per
project, and give no other service or secret a name that begins with `kp-`.

A service made as an earlier pack service account isn't taken for one of
the orchestrator's after the account changes. Its deployment waits, with
`service-start-failed` for its tenant and a log line naming the service,
until you delete the service by hand.

Grant the pack service account
`roles/secretmanager.secretAccessor` on the `kp-` secrets alone, with the
condition `resource.name.startsWith("projects/<project number>/secrets/kp-")`.

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
