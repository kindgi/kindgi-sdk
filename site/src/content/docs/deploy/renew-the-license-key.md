---
title: Renew the license key
description: Keep a deployment's license key current with kindgi license. Enroll the deployment once, then renew its key by hand or on your own schedule.
sidebar:
  order: 3.2
---

When you finish this page, your deployment renews its own non-production
license key, by hand or on your own schedule.

A license key runs until its date
([When a key expires](../../concepts/licensing/#when-a-key-expires)). How you
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

- **A non-production key from access.kindgi.com,** and the GitHub login you
  sign in there with.
- **The `kindgi` CLI, 0.1.7 or later,** on a machine that can read and write
  where your keys are kept. Outside a project, run it as
  `npx --yes @kindgi/cli@0.1` ([Install](../../start/install/)).
- **A place for each key,** from [Where the keys are kept](#where-the-keys-are-kept).

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

Whatever runs `renew` needs to read both values, and to write the license
key's.

## 1. Enroll the deployment, once

`enroll` makes the deployment's renewer: a key pair whose public half
access.kindgi.com trusts.

```sh
kindgi license enroll --for <your GitHub login> --renewer gcp:projects/acme-prod/secrets/kindgi-license-renewer
```

- `--for` is the GitHub login you sign in to access.kindgi.com with. The
  renewer works for it alone.
- `--renewer` is where to keep the renewer's private key, as a reference
  from [Where the keys are kept](#where-the-keys-are-kept).

`enroll` keeps the private key at `--renewer`. It prints the renewer's id
(`lr_…`), a line to add at access.kindgi.com (`kgi_lrp_…`), and the `renew`
command to run next:

```text
Renewer lr_c1DXmGBUpkAT6wd10BARbp: its private key is in ….

Add this deployment on https://access.kindgi.com, signed in as …, under "Renew the key from your deployment":

  kgi_lrp_…

Then renew the key whenever you like, by hand or on your own schedule:

  kindgi license renew --key <where the license key is> --renewer …
```

Run `enroll` again with the same `--renewer`, and it reuses the key it finds
there. `--replace` makes a new one instead. The old one stops working once
you add the new line.

## 2. Add the renewer at access.kindgi.com

Sign in at access.kindgi.com as the login you gave `--for`. Under **Renew the
key from your deployment**, add the `kgi_lrp_…` line that `enroll` printed.
access.kindgi.com keeps only the renewer's public key.

## 3. Renew

`renew` asks access.kindgi.com for the key's next version, and writes it
where the runtime reads the key:

```sh
kindgi license renew --key gcp:projects/acme-prod/secrets/kindgi-license-key \
  --renewer gcp:projects/acme-prod/secrets/kindgi-license-renewer
```

- `--key` is where the license key is kept, and where the new one goes.
- `--renewer` is where `enroll` kept the renewer's private key.
- With a `kindgi.env`, `--env-file kindgi.env` stands for
  `--key env-file:kindgi.env#KINDGI_LICENSE_KEY`.

`renew` checks the answer offline before it writes anything: Kindgi's
signature, the same licensee and use, and no earlier end date. It writes
only a key that's new, and prints one line:

- `renewed: <name>'s <use> key, until <date> (renewer lr_…)`, and that the
  runtime uses the new key from its next start. Until then, the runtime runs
  on the key it started with.
- `unchanged: …` when there's no newer key. A non-production key gets its
  next one in its last 30 days.

In the key's last 30 days, `renew` adds a line that starts
`⚠ It expires in <N> days`. It says how to get a key if `renew` keeps
answering `unchanged`.

A refusal or a failure goes to stderr and exits `1`, so your scheduler's
alerting sees it. The key is left as it was. A failure says what's wrong.
Here, a scheduled run on Azure for a deployment that wasn't enrolled:

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
- `license_renewer_secret` names the renewer's secret, `license-renewer` by
  default. The outputs `license_enroll_command` and `license_renew_command`
  print the two commands for this deployment.

The module's README has the details.

## What renewing sends

Only the renewal request: the renewer's id, the time and a one-time value,
signed with the renewer's private key. No license key, run or data leaves
the deployment. Nothing is sent between runs of `renew`.

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

- [Licensing](../../concepts/licensing/): which key a deployment needs, and
  what happens when one expires.
- [Azure Container Apps](../azure-container-apps/): the module that renews
  on a schedule.
- [Operate a self-hosted runtime](../operate/): health, backups, upgrades and
  rotating keys.
