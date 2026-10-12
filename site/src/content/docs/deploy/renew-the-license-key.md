---
title: Renew the license key
description: Keep a deployment's license key current with kindgi license, from 0.1.7. Enroll the deployment once, then renew its key by hand or on your own schedule.
sidebar:
  order: 3.2
---

A license key runs until its date
([When a key expires](../../concepts/licensing/#when-a-key-expires)). How you
get the next one depends on where the key came from:

- **A production key** is renewed with your contract: write to
  contact@kindgi.com.
- **A non-production key from [access.kindgi.com](https://access.kindgi.com)**
  can be renewed by the deployment itself, from 0.1.7. Enroll the deployment
  once, then run `kindgi license renew` whenever you like, by hand or from
  your own scheduler. Nothing calls Kindgi unless you run it. You can also
  sign in at access.kindgi.com for a new key, as before.

:::note
Renewing from a deployment has to be on at access.kindgi.com. Until it is,
the page you sign in to has no **Renew the key from your deployment**
section, and `kindgi license renew` answers that `https://access.kindgi.com`
answered `404`. Sign in at access.kindgi.com for a new key instead, or write
to contact@kindgi.com.
:::

## Where the keys are kept

`kindgi license` reads and writes two values, each named by a reference:

- **the license key** (`--key`), where the runtime reads it;
- **the renewer's private key** (`--renewer`), which `enroll` makes. It
  never leaves where you keep it, and it's never printed.

| Reference | Where |
| --- | --- |
| `file:<path>` | A whole file, such as a mounted secret. |
| `env-file:<path>#<NAME>` | One line of an env file, such as `kindgi.env`. The other lines are kept as they are. |
| `gcp:projects/<project>/secrets/<name>` | Google Secret Manager: reads the latest version, writes a new one. |
| `azure:https://<vault>.vault.azure.net/secrets/<name>` | Azure Key Vault: reads the current version, writes a new one. |
| `aws:<region>:<name>`, or `aws:<the secret's ARN>` | AWS Secrets Manager: reads `AWSCURRENT`, writes a new version. |

A new version leaves the old ones, so a runtime that reads the latest
version gets the new key at its next start. A file is replaced in one step
and keeps its mode; a new file is created `0600`.

The cloud stores sign in as the platform's own identity:

- **Google:** the metadata server (Cloud Run, Compute Engine), else
  `gcloud auth print-access-token`.
- **Azure:** the managed identity (`KINDGI_AZURE_CLIENT_ID` names a
  user-assigned one), else `az account get-access-token`.
- **AWS:** the first that answers: the environment (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`), a web identity
  (`AWS_ROLE_ARN` with `AWS_WEB_IDENTITY_TOKEN_FILE`), the container's
  credentials, the instance's role (IMDSv2), or the AWS CLI's
  (`aws configure export-credentials`).

Whatever runs `renew` needs to read both values and to write the license
key's.

## 1. Enroll the deployment, once

```sh
kindgi license enroll --for <your GitHub login> --renewer gcp:projects/acme-prod/secrets/kindgi-license-renewer
```

`--for` is the GitHub login you sign in to access.kindgi.com with. `enroll`
makes the renewer's key pair and keeps the private key at `--renewer`. It
prints the renewer's id (`lr_…`), a line to add (`kgi_lrp_…`), and the
`renew` command to run next.

Sign in at access.kindgi.com as that login, and add the line under **Renew
the key from your deployment**. access.kindgi.com keeps only the renewer's
public key.

Run `enroll` again with the same `--renewer` and it reuses the key it finds
there. `--replace` makes a new one; the old one stops working once you add
the new line.

## 2. Renew

```sh
kindgi license renew --key gcp:projects/acme-prod/secrets/kindgi-license-key \
  --renewer gcp:projects/acme-prod/secrets/kindgi-license-renewer
```

With a `kindgi.env`, `--env-file kindgi.env` stands for
`--key env-file:kindgi.env#KINDGI_LICENSE_KEY`.

`renew` asks access.kindgi.com for the key's next version, and checks the
answer offline before it writes anything: Kindgi's signature, the same
licensee and use, and no earlier end date. It writes only a key that's new,
and prints one line:

- `renewed: <name>'s <use> key, until <date> (renewer lr_…)`, and that the
  runtime uses the new key from its next start. Until then it runs on the
  one it started with.
- `unchanged: …` when there's no newer key. A non-production key gets its
  next one in its last 30 days.

In the key's last 30 days, `renew` adds a line that starts
`⚠ It expires in <N> days`, with how to get a key if it keeps answering
`unchanged`.

A refusal or a failure goes to stderr and exits `1`, so your scheduler's
alerting sees it, and the key is left as it was. A failure says what's
wrong, as here, from a scheduled run on Azure that hadn't been enrolled yet:

```text
There's no renewer key in the Key Vault secret license-renewer (vault …). Enroll this deployment first: kindgi license enroll --for <your GitHub login> --renewer <where to keep its key>.
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

## On a schedule

Any scheduler that can run the CLI will do: cron, a CI schedule, a
scheduled job. Once a day is plenty.

**On Azure,** the Terraform module runs it for you
([Azure Container Apps](../azure-container-apps/)). Enroll first, then set
`license_renewal_schedule` (a cron, in UTC) and apply:

- It adds a Container Apps job that runs `kindgi license renew` on the
  runtime image, as an identity of its own. That identity reads the license
  key and the renewer's key, and can only set the license key.
- Two alerts come with it: a run that failed, and a key within 7 days of
  its end.
- `license_renewer_secret` names the renewer's secret (`license-renewer` by
  default), and the outputs `license_enroll_command` and
  `license_renew_command` print the two commands for this deployment.

The module's README has the details.

## What renewing sends

Only the renewal request: the renewer's id, the time and a one-time value,
signed with the renewer's private key. No license key, run or data leaves
the deployment, and nothing is sent between runs of `renew`.

## The runtime's warnings

From 30 days before the key's date, the runtime's banner warns, and ends
with how to renew. For a non-production key from access.kindgi.com, that's
the `renew` command, with this deployment's `--key` and `--renewer` when it
sets `KINDGI_LICENSE_KEY_REF` and `KINDGI_LICENSE_RENEWER_REF` (the Azure
module does), or signing in at access.kindgi.com. For a production key, it's
contact@kindgi.com. A tenant admin sees a line on every console page too.
