---
title: Connect Gemini on Vertex AI
description: Register Gemini from the gemini preset, using your Google Cloud credentials instead of an API key.
sidebar:
  order: 2
---

This guide connects Gemini on Vertex AI to your agents, with your Google
Cloud credentials instead of an API key.

The `gemini` preset registers Gemini 3.8 Flash and Gemini 3.5 Flash Lite on
Google Cloud's Vertex AI. It takes no API key: calls use your Google Cloud
credentials, and Vertex AI runs and bills them in a project you name.

## Before you start

- **A pack** with `kindgi dev` running, from Kindgi 0.2's CLI.
- **The `gcloud` CLI.**
- **A Google Cloud project** with the Vertex AI API turned on, and an account
  with access to Vertex AI in it: yours, or a service account you
  [impersonate](#as-a-service-account-by-impersonation).

## 1. Log in to Google Cloud

The runtime calls Vertex AI with your credentials. Log in once:

```sh
gcloud auth application-default login
```

It opens a browser to sign in. That writes your Application Default
Credentials to `~/.config/gcloud/application_default_credentials.json`. The
account needs access to Vertex AI in the project.

`kindgi dev` gives the runtime Google credentials only when you say which, with
`KINDGI_DEV_GOOGLE_CREDENTIALS`. Set it in the pack's `.env`, in `.env.local`
for a path that's only yours, or in the shell:

```sh
# .env
KINDGI_DEV_GOOGLE_CREDENTIALS=adc
```

`adc` is your `gcloud` login. An absolute path names another credentials
file, such as a service-account key. `off`, the default, gives none. `kindgi dev`
mounts the file read-only, and names it and whose it is when it starts:

```text
✓ Google credentials: /Users/you/.config/gcloud/application_default_credentials.json (your gcloud application-default login, a user account), mounted read-only for Vertex AI
```

When the file names a quota project, the line names it too, after whose it
is: `, quota project <gcp-project>`.

Without the setting, a `gemini` provider has no credentials and its calls
fail. `kindgi dev` says so when it starts, and `kindgi doctor` says the same:

```text
⚠ Provider gemini (Vertex AI) has no Google credentials: set KINDGI_DEV_GOOGLE_CREDENTIALS=adc (or a credentials file), in the pack's .env or the shell, and restart kindgi dev.
```

A `GOOGLE_APPLICATION_CREDENTIALS` in your shell isn't used unless you name it:
`KINDGI_DEV_GOOGLE_CREDENTIALS=$GOOGLE_APPLICATION_CREDENTIALS`.

### As a service account, by impersonation

If your organization doesn't let your own account call Vertex AI, or doesn't
let you create a service-account key, sign in as a service account by
impersonation. You log in as yourself, and Google gives the runtime
short-lived tokens for the service account. No key file is made.

It needs, in Google Cloud:

- **The service account** to have Vertex AI User (`roles/aiplatform.user`)
  in the project.
- **Your account** to have Service Account Token Creator
  (`roles/iam.serviceAccountTokenCreator`) on the service account.
- **The project** to have the IAM Service Account Credentials API turned on.

Use a service account made for development, not the one a deployed runtime
runs as: whoever can impersonate an account can do whatever it can.

Then log in through it:

```sh
gcloud auth application-default login --impersonate-service-account=<service-account-email>
```

`<service-account-email>` is the service account's email, such as
`kindgi-dev@<gcp-project>.iam.gserviceaccount.com`. It opens a browser for
your own sign-in, and writes Application Default Credentials that impersonate
the service account, in place of your own login. `KINDGI_DEV_GOOGLE_CREDENTIALS=adc`
uses them as before. Restart `kindgi dev`, and it names the service account
when it starts:

```text
✓ Google credentials: /Users/you/.config/gcloud/application_default_credentials.json (impersonating kindgi-dev@<gcp-project>.iam.gserviceaccount.com), mounted read-only for Vertex AI
```

If the model calls fail with a permission denied, the message names what's
missing:

- **`iam.serviceAccounts.getAccessToken`:** the account you signed in with
  in the browser can't impersonate the service account. Grant it Service
  Account Token Creator on the service account. If you have more than one
  Google account, run the login above again and pick the one with that role.
  A new grant can take a few minutes to apply.
- **The IAM Service Account Credentials API,** not yet used in the project,
  or turned off: turn it on in the project the message names.
- **`aiplatform.endpoints.predict`:** the service account can't call Vertex
  AI. Grant it Vertex AI User in the project.

To call Vertex AI as yourself again, run `gcloud auth application-default login`
without the flag, and restart `kindgi dev`.

## 2. Register the preset

Register the preset's models with the runtime:

```sh
pnpm exec kindgi providers register --preset=gemini --project=<gcp-project>
```

It prints `✓ Registered gemini:` with the models it registered.
`--preset=gemini` names the preset. `--project` is the Google Cloud project
Vertex AI runs and bills in, and `<gcp-project>` is its id. The preset
refuses to register without it:

```text
Error: preset "gemini" needs --project=<…> (The Google Cloud project Vertex AI bills and authorises against.)
```

`--models` registers only some of the models:

```sh
pnpm exec kindgi providers register --preset=gemini --project=<gcp-project> --models=gemini-3.8-flash
```

```text
{
  "providerId": "gemini"
}
✓ Registered gemini: gemini-3.8-flash (default)
```

The preset's models answer with up to 65,536 tokens, thinking included.
`--max-output-tokens=<n>` registers them with another limit, `<n>` tokens.

To have `kindgi dev` register it on every boot, ask your coding agent to
declare it in the pack's config instead. Kindgi's skills in your pack tell it
how ([How it knows Kindgi](../../../start/coding-agents/)). It goes there as
`{ preset: 'gemini', project: '<gcp-project>' }` in `kindgi.config.ts`'s
`providers`, or a `[[tool.kindgi.providers]]` table with `preset = "gemini"`
and `project = "<gcp-project>"` in `pyproject.toml`.
[Declare them in your pack's config](../#declare-them-in-your-packs-config)
shows how.

## What it registers

Get the provider by its id to see what it registered:

```sh
pnpm exec kindgi providers get gemini
```

It prints the provider as JSON. Its id is `gemini` and its region `global`,
where Vertex AI serves Gemini 3.8 Flash, which isn't served from
`us-central1`. Both models list `tool-use`, `structured-output` and
`long-context`:

| Model | Context window | Per 1K input / output tokens |
| --- | --- | --- |
| `gemini-3.8-flash` (default) | 1,048,576 | $0.00075 / $0.00375 |
| `gemini-3.5-flash-lite` | 1,048,576 | $0.0003 / $0.0025 |

- **Gemini 3.8 Flash thinks before it answers,** and Vertex AI bills the
  thinking as output tokens. Kindgi counts them in the turn's output tokens
  and its cost: in a check on 2026-10-07, a one-word answer used 94 output
  tokens, 93 of them thinking. Gemini 3.5 Flash Lite answered without
  thinking.
- **Its price is Google's launch price,** through 2026-12-31. From
  2027-01-01 Google charges $0.0015 / $0.0075 per 1K tokens, and a turn's
  `totalCostUsd` still uses the price the provider was registered with.

To send an agent to Gemini when other providers are registered too, set
`preferredProvider: 'gemini'`, or `preferred_provider="gemini"` in Python.
Or require it, as
[Choose the model an agent uses](../../agents/choose-a-model/) shows.

## Make it think less

Gemini 3.8 Flash thinks on every call, as much as Google sets unless it's
given a level, and `low` is the least it takes. The thinking bills as output
tokens, and it counts against the call's output
limit too, so a high level with a small `maxOutputTokens` can end with no
answer.

An agent asks for a level with `thinking` in its model settings, as
[Temperature and thinking](../#temperature-and-thinking) shows. A call that
asks none gets the model's `thinking.default`, from the provider's
registration. Gemini 3.8 Flash takes `low`, `medium` and `high`, and its
`lowest` is `low`. Vertex AI refuses `minimal` on it. In a check on
2026-10-07, the same short verdict took 31 tokens of thinking at `low`, and
67 without a level.

The preset doesn't set a `default`, and a registration can't be edited. So
unregister the preset's provider and register it again from a file. Save
this as `gemini.json`, with your project in place of `<gcp-project>`:

```json
{
  "adapter_id": "@kindgi/adapter-model-gemini",
  "adapter_config": { "project": "<gcp-project>" },
  "metadata": {
    "id": "gemini",
    "region": "global",
    "defaultModel": "gemini-3.8-flash",
    "models": [
      { "name": "gemini-3.8-flash", "contextWindow": 1048576, "maxOutputTokens": 65536,
        "thinking": { "mode": "adaptive", "lowest": "low", "default": "low" },
        "features": ["tool-use", "structured-output", "long-context"],
        "cost": { "promptUsdPer1kTokens": 0.00075, "completionUsdPer1kTokens": 0.00375 } },
      { "name": "gemini-3.5-flash-lite", "contextWindow": 1048576, "maxOutputTokens": 65536,
        "thinking": { "mode": "adaptive", "lowest": "minimal" },
        "features": ["tool-use", "structured-output", "long-context"],
        "cost": { "promptUsdPer1kTokens": 0.0003, "completionUsdPer1kTokens": 0.0025 } }
    ]
  }
}
```

```sh
pnpm exec kindgi providers unregister gemini
pnpm exec kindgi providers register --spec=@gemini.json
```

If your pack's config declares the preset, change that entry instead: put a
`spec` entry with this file's contents in its place, and restart
`kindgi dev`. It registers the level itself on every boot, in each worktree
and on a teammate's machine
([Declare them in your pack's config](../#declare-them-in-your-packs-config)).

- **A `default` the model doesn't take** is refused, naming the levels it
  takes: `lowest`, then `low`, `medium` and `high` for Gemini 3.8 Flash.
- **An agent's level wins over it.** A call that asks for the least
  thinking, as a judge does, gets the model's `lowest`.
- **It needs runtime 0.3.0 or later.** An older runtime refuses a model's
  `thinking` with a `default`.

### A registration that set `thinkingLevels`

An older registration may set its levels in the provider's
`adapter_config.thinkingLevels`, such as `"gemini-3.8-flash=low"`. One
stored with it still builds, but the key isn't read, so its
models think as Google sets by default until you register it again.
`GET /v1/providers/gemini/check` lists the key in `warnings`, and
`kindgi doctor` shows the provider as a warning with the steps to fix it. A
new registration with the key is refused, naming the new place:

```text
✗ /adapter_config/thinkingLevels: adapter_config.thinkingLevels isn't read here: its setting is metadata.models[].thinking.default.
```

To fix it, move each `model=level` pair into that model's `thinking` as its
`default`, and register the provider again from the file, as above. This
`adapter_config`:

```json
{ "project": "<gcp-project>", "thinkingLevels": "gemini-3.8-flash=low" }
```

becomes `{ "project": "<gcp-project>" }`, with `"default": "low"` in
`gemini-3.8-flash`'s `thinking`.

## On a runtime that keeps tenants apart

A runtime with `KINDGI_TENANT_HOST_ACCESS=isolated` doesn't lend its own Google
credentials to what a tenant registers. There, put a service-account key (its
JSON) in a secret and name it in the provider's `secret_ref`. Without one, the
registration is refused, naming `secret_ref`:

```text
Error [invalid-request]: Provider "gemini" doesn't fit adapter @kindgi/adapter-model-gemini: uses Vertex AI without secret_ref, which signs in with the server's own Google credentials (Application Default Credentials); this deployment doesn't let tenant configuration use them (KINDGI_TENANT_HOST_ACCESS). Name a service-account key in secret_ref.
  ✗ /secret_ref: uses Vertex AI without secret_ref, which signs in with the server's own Google credentials (Application Default Credentials); this deployment doesn't let tenant configuration use them (KINDGI_TENANT_HOST_ACCESS). Name a service-account key in secret_ref.
```

## If you registered Gemini 2.5

An earlier preset registered `gemini-2.5-pro` and `gemini-2.5-flash`.
Vertex AI retires both on **2026-10-20**. After that, a turn routed to them
fails. Update the CLI, then:

- **A provider you registered with `kindgi providers register`:** unregister
  it and register the preset again. A registration can't be edited:

  ```sh
  pnpm exec kindgi providers unregister gemini
  pnpm exec kindgi providers register --preset=gemini --project=<gcp-project>
  ```

  `unregister` prints its answer as JSON, and `register` prints its
  `✓ Registered gemini:` line.

- **A provider the pack's config declares:** restart `kindgi dev`. It
  registers the preset's new models in place of the old ones:

  ```text
    Providers from kindgi.config.ts:
      ✓ gemini: registered again (changed in kindgi.config.ts)
  ```

  A declaration whose `models` names a Gemini 2.5 model stops `kindgi dev`
  from starting, as `--models` does with `kindgi providers register`. Name
  one of the new models instead:

  ```text
  kindgi dev: `providers` in kindgi.config.ts: entry 1: preset "gemini" has no model gemini-2.5-flash — it has gemini-3.8-flash, gemini-3.5-flash-lite
  ```

An agent that prefers or requires a Gemini 2.5 model needs a new version that
names one of these: a preference falls to the next model in line, and a
requirement matches nothing.

## From a deployed runtime

A deployed runtime has no login of yours: it calls Vertex AI as its own
service account. On Cloud Run, that's the service's account. That account needs
`roles/aiplatform.user` in the project, and the project needs the Vertex AI
API turned on. Without the role, every model call fails with
`Permission 'aiplatform.endpoints.predict' denied`.
[Deploy on Google Cloud Run](../../../deploy/self-hosted/cloud-run/#use-gemini) sets this up.

## Next

- [Choose the model an agent uses](../../agents/choose-a-model/)
- [Deploy on Google Cloud Run](../../../deploy/self-hosted/cloud-run/#use-gemini)
- [Models](../)
