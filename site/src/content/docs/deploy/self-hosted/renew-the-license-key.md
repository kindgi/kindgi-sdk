---
title: Renew the license key
description: Keep a deployment's license key current with kindgi license. Enroll the deployment once, then renew its key by hand or on your own schedule.
sidebar:
  order: 3.2
---

When you finish this page, your deployment renews its own non-production
license key, by hand or on your own schedule.

A license key runs until its date
([When a key expires](../../../concepts/licensing/#when-a-key-expires)). How you
get the next one depends on where the key came from:

- **A production key** is renewed with your contract: write to
  contact@kindgi.com.
- **A non-production key from [access.kindgi.com](https://access.kindgi.com)**
  can be renewed by the deployment itself. You enroll the deployment once.
  Then you run `kindgi license renew` whenever you like, by hand or from your
  own scheduler. Nothing calls Kindgi unless you run it. You can also sign in
  at access.kindgi.com for a new key.

:::note
Renewing from a deployment needs to be turned on at access.kindgi.com. Where
it isn't, the page you sign in to has no **Renew the key from your
deployment** section. `kindgi license renew` then answers that
`https://access.kindgi.com` answered `404`. Sign in at access.kindgi.com for
a new key instead, or write to contact@kindgi.com.
:::

## Before you start

- **A non-production key from access.kindgi.com.** After you sign in there,
  your key page shows the account a renewer is for, under **Renew the key
  from your deployment**: your GitHub login, or an `em-…` id.
- **The `kindgi` CLI, 0.1.7 or later,** on a machine that can read and write
  where your keys are kept. It runs from any folder as
  `npx --yes @kindgi/cli@0.1` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead.
- **A place for each key,** from [Where the keys are kept](#where-the-keys-are-kept).

## Where the keys are kept

`kindgi license` reads and writes these, each named by a reference:

- **the license key** (`--key`), where the runtime reads it;
- **the renewer's private key** (`--renewer`), which `enroll` makes. It
  never leaves where you keep it, and it's never printed;
- **a token for the runtime** (`--runtime-token`), read only, when a renewal
  carries counts (`--runtime`): a [key for the counts](#a-key-for-the-counts),
  or the runtime's own token.

Give each flag where the value is kept, never the value itself. A flag that
isn't a reference is refused without repeating it, in case it's the secret.

| Reference | Where |
| --- | --- |
| `file:<path>` | A whole file, such as a mounted secret. |
| `env-file:<path>#<NAME>` | One line of an env file, such as `kindgi.env`. The other lines are kept as they are. |
| `gcp:projects/<project>/secrets/<name>` | Google Secret Manager: reads the latest version, writes a new one. |
| `azure:https://<vault>.vault.azure.net/secrets/<name>` | Azure Key Vault: reads the current version, writes a new one. |
| `aws:<region>:<name>`, or `aws:<the secret's ARN>` | AWS Secrets Manager: reads `AWSCURRENT`, writes a new version. |

A new version leaves the old ones, so a runtime that reads the latest
version gets the new key at its next start. A file is replaced in one step,
and keeps its mode. A new file is created with the mode `0600`.

The cloud stores sign in as the platform's own identity:

- **Google:** the metadata server on Cloud Run and Compute Engine, else
  `gcloud auth print-access-token`.
- **Azure:** the managed identity, else `az account get-access-token`.
  `KINDGI_AZURE_CLIENT_ID` names a user-assigned identity.
- **AWS:** the first of these that answers:
  - the environment: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
    `AWS_SESSION_TOKEN`;
  - a web identity: `AWS_ROLE_ARN` with `AWS_WEB_IDENTITY_TOKEN_FILE`;
  - the container's credentials;
  - the instance's role, through IMDSv2;
  - the AWS CLI's, from `aws configure export-credentials`.

Whatever runs `renew` needs to read these, and to write the license key's.

## 1. Enroll the deployment, once

`enroll` makes the deployment's renewer: a key pair whose public half
access.kindgi.com trusts.

```sh
npx --yes @kindgi/cli@0.1 license enroll --for <your GitHub login or em- id> --renewer gcp:projects/acme-prod/secrets/kindgi-license-renewer
```

- `--for` is that account: your GitHub login, or the `em-…` id your key page
  shows. The renewer works for it alone.
- `--renewer` is where to keep the renewer's private key, as a reference
  from [Where the keys are kept](#where-the-keys-are-kept).

`enroll` keeps the private key at `--renewer`. It prints the renewer's id
(`lr_…`), a line to add at access.kindgi.com (`kgi_lrp_…`), and the `renew`
command to run next:

```text
Renewer lr_c1DXmGBUpkAT6wd10BARbp: its private key is in ….

Add this deployment on https://access.kindgi.com, signed in as the person it's for (…), under "Renew the key from your deployment":

  kgi_lrp_…

Then renew the key whenever you like, by hand or on your own schedule:

  kindgi license renew --key <where the license key is> --renewer …
```

Run `enroll` again with the same `--renewer`, and it reuses the key it finds
there. `--replace` makes a new one instead. The old one stops working once
you add the new line.

## 2. Add the renewer at access.kindgi.com

Sign in at access.kindgi.com, with GitHub or your email address, as the person
you gave `--for`. Under **Renew the key from your deployment**, add the
`kgi_lrp_…` line that `enroll` printed.
access.kindgi.com keeps only the renewer's public key.

## 3. Renew

`renew` asks access.kindgi.com for the key's next version, and writes it
where the runtime reads the key:

```sh
npx --yes @kindgi/cli@0.1 license renew --key gcp:projects/acme-prod/secrets/kindgi-license-key \
  --renewer gcp:projects/acme-prod/secrets/kindgi-license-renewer
```

- `--key` is where the license key is kept, and where the new one goes.
- `--renewer` is where `enroll` kept the renewer's private key.
- With a `kindgi.env`, `--env-file kindgi.env` stands for
  `--key env-file:kindgi.env#KINDGI_LICENSE_KEY`.
- `--runtime <url>` with `--runtime-token <ref>`: this deployment's runtime,
  and where a token for it is kept, as a reference from
  [Where the keys are kept](#where-the-keys-are-kept): a
  [key for the counts](#a-key-for-the-counts), or the runtime's own token
  (`KINDGI_API_TOKEN`). The renewal then
  carries counts of the deployment's use since the current key was issued
  ([What renewing sends](#what-renewing-sends)).
  - `<url>` is the runtime's URL as `KINDGI_API_URL` gives it, path included,
    over http or https, with no credentials in it.
  - Counts are for a non-production key: a production key's renewal carries
    none, and the runtime isn't asked.
  - They need the CLI and the runtime at 0.1.8 or later. Without them, the
    key still renews.

`renew` checks the answer offline before it writes anything: Kindgi's
signature, the same licensee and use, and no earlier end date. It writes
only a key that's new, and prints one line:

- `renewed: <name>'s <use> key, until <date> (renewer lr_…)`, and that the
  runtime uses the new key from its next start. Until then, the runtime runs
  on the key it started with.
- `unchanged: …` when there's no newer key. A non-production key gets its
  next one in its last 30 days.

With `--runtime`, a line says what the renewal carried:

- `counts: sent (<runs> runs, <people> people, <n> in production since <date>, runtime <version>)`.
  The `, <n> in production` part comes only from a runtime that can put
  projects in production.
- `counts: not sent (<why>); this renewal goes without them.` when there
  are none to send: a production key's renewal, a token that can't be read
  or sent, or a runtime that couldn't say (no answer, a 404 from a runtime
  that doesn't report its use, a refusal, an error, or an answer that isn't
  counts, as access.kindgi.com reads them). The key still renews.

On a refusal, the line goes to stderr, before `refused (…)`.

A renewal that goes without counts still exits `0`, whether it renews the
key or answers `unchanged`, so your scheduler's alerting doesn't see it.
To hear about it, match `counts: not sent (` in `renew`'s output, and
leave out `counts: not sent (a production key's renewal carries no counts)`,
which is expected. On Azure, with `license_usage_key_secret` set, the
module raises this alert itself ([On a schedule](#on-a-schedule)).

In the key's last 30 days, `renew` adds a line that starts
`⚠ It expires in <N> days`. It says how to get a key if `renew` keeps
answering `unchanged`.

A refusal or a failure goes to stderr and exits `1`, so your scheduler's
alerting sees it. The key is left as it was. A failure says what's wrong.
Here, a scheduled run on Azure for a deployment that wasn't enrolled:

```text
There's no renewer key in the Key Vault secret license-renewer (vault …). Enroll this deployment first: kindgi license enroll --for <your GitHub login, or the em- id your key page shows> --renewer <where to keep its key>.
```

A refusal from access.kindgi.com names its code, `refused (<code>): …`:

| Code | What to do |
| --- | --- |
| `unauthorized` | Enroll the deployment, and add its line at access.kindgi.com. |
| `stale-request` | Check the machine's clock: it's more than 5 minutes off. |
| `replayed` | Run `renew` again: each request is used once. |
| `rate-limited` | Wait an hour, then run `renew` again: too many renewals came for this key this hour. |
| `renewer-stopped` | Its renewal was stopped at access.kindgi.com. Enroll it again, or sign in there for a key. |
| `not-entitled` | A production key is renewed with your contract: write to contact@kindgi.com. |
| `term-ended` | The contract's term has ended, and the key you have runs until its own date. Write to contact@kindgi.com to extend the term. |
| `key-revoked`, `denied` | Write to contact@kindgi.com. |
| `held-for-review` | This renewal's counts are above what a non-production key covers, so it got no new key: write to contact@kindgi.com about a production license. Kindgi can release the deployment after a review, and its renewals then aren't held until a date. The key you have runs until its own date. A renewal before the key is due gets the same key back. |

## A key for the counts

`renew --runtime` reads the counts with any token that can read
`GET /v1/license/usage`. The runtime's own token can do everything else too,
so give a renewal that runs on its own a system key holding
`system:license`. That key reads the license and its use, and every other
route refuses it.

Mint it with the runtime's own token. On a runtime serving one tenant
(runtime 0.1.10 or later), only that token mints system keys, and only ones
holding `system:license`. The token reaches `curl` as a header file, so it
never shows in the list of processes:

```sh
curl -sS -X POST "$KINDGI_API_URL/v1/system/keys" \
  -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN") \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"scopes": ["system:license"], "label": "license renewal"}'
```

- **The key comes back once,** in the answer's `token`. Keep it where
  `--runtime-token` can read it
  ([Where the keys are kept](#where-the-keys-are-kept)), and give `renew`
  that reference. On Azure, the module's README puts it in the vault without
  printing it. A mint sent again with the same `Idempotency-Key` doesn't
  return it: mint another.
- **On a runtime serving many tenants,** the same call mints it, with the
  runtime's own token or a system key holding `kindgi:system`.
- **List the keys, and revoke one,** with the runtime's own token too. The
  list never shows a key's token, and a revoked key is refused from its next
  request:

  ```sh
  curl -sS "$KINDGI_API_URL/v1/system/keys" \
    -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN")
  curl -sS -X POST "$KINDGI_API_URL/v1/system/keys/<keyId>/revoke" \
    -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN") \
    -H "Idempotency-Key: $(uuidgen)"
  ```

- **A system key holding any other scope** is refused on every route of a
  runtime serving one tenant
  ([`system-key-scope-not-served`](../../../reference/errors/#system-key-scope-not-served)):
  one minted while it served many tenants, say. Revoke it, and mint one
  holding `system:license`.
- **A runtime serving one tenant that answers the mint with
  `403 system-principal-required`** is older than 0.1.10, which has these
  keys. Until you upgrade it, `--runtime-token` takes its own token.

## On a schedule

Any scheduler that can run the CLI will do: cron, a CI schedule, or a
scheduled job. Once a day is plenty.

**On Azure,** the Terraform module runs it for you
([Azure Container Apps](../azure-container-apps/)). Enroll first. Then set
`license_renewal_schedule`, a cron in UTC, and apply:

- The module adds a Container Apps job that runs `kindgi license renew` on
  the runtime image, as an identity of its own. That identity reads the
  license key and the renewer's key, and can only set the license key.
- Two alerts come with it: a run that failed, and a key within 7 days of its
  end.
- `license_usage_key_secret` names the vault secret holding a
  [key for the counts](#a-key-for-the-counts), which you put there before
  you apply. With it, the job reads that secret too, and its renewals carry
  counts. A third alert comes with it: a run that sent none, other than a
  production key's. Terraform never holds the key.
- `license_renewer_secret` names the renewer's secret, `license-renewer` by
  default. The outputs `license_enroll_command` and `license_renew_command`
  print the two commands for this deployment.

The module's README has the details.

## What renewing sends

The renewal request: the renewer's id, the time and a one-time value, signed
with the renewer's private key. No license key, run or data leaves the
deployment. Nothing is sent between runs of `renew`.

With `--runtime`, the request also carries counts of the deployment's use
since its current key was issued, signed with the rest. `renew` reads them
from the runtime (`GET /v1/license/usage`, which only the deployment's own
token, or a [system key holding `system:license`](#a-key-for-the-counts),
can read):

- **runs:** the runs started, not counting dry runs, replays, evals or the
  runs another run starts;
- **people:** the distinct people who started runs or decided approvals,
  counted in each tenant and summed, so a person in two tenants counts twice;
- **projects in production,** from a runtime that can
  [put projects in production](../../../guides/projects/organize-by-org-and-project/#put-a-project-in-production);
- **the runtime's version,** and the period they cover.

A tenant the runtime can't count is left out, and its log names it (a
warning under `license`), so the counts can be lower than the use. When it
can't count any of its tenants, it answers an error instead, and the renewal
goes without counts.

They're counts only: no content, names or ids. Until the date on Kindgi's
[privacy page](https://www.kindgi.com/privacy), access.kindgi.com
keeps only whether a renewal carried counts. From that date, it keeps them
with the renewal's record, kept 400 days, and the latest ones with the
deployment's renewer, kept until the account is deleted. Kindgi reads them to
see production-like use of non-production keys. Above levels Kindgi sets, a
non-production key's renewal is held for review once a new key is due
(`held-for-review`).

## The runtime's warnings

From 30 days before the key's date, the runtime's banner warns, and ends
with how to renew:

- **For a non-production key from access.kindgi.com,** that's the `renew`
  command, or signing in at access.kindgi.com. The command has this
  deployment's `--key` and `--renewer` when it sets `KINDGI_LICENSE_KEY_REF`
  and `KINDGI_LICENSE_RENEWER_REF`, as the Azure module does.
- **For a production key,** it's contact@kindgi.com.

A tenant admin sees a line on every console page too.

## Next

- [Licensing](../../../concepts/licensing/): which key a deployment needs, and
  what happens when one expires.
- [Azure Container Apps](../azure-container-apps/): the module that renews
  on a schedule.
- [Operate a self-hosted runtime](../operate/): health, backups, upgrades and
  rotating keys.
