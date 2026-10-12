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

- **A pack** with `kindgi dev` running, from Kindgi 0.1's CLI.
- **The `gcloud` CLI.**
- **A Google Cloud project** with the Vertex AI API turned on, and an account
  with access to Vertex AI in it.

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

Without the setting, a `gemini` provider has no credentials and its calls
fail. `kindgi dev` says so when it starts, and `kindgi doctor` says the same:

```text
⚠ Provider gemini (Vertex AI) has no Google credentials: set KINDGI_DEV_GOOGLE_CREDENTIALS=adc (or a credentials file), in the pack's .env or the shell, and restart kindgi dev.
```

A `GOOGLE_APPLICATION_CREDENTIALS` in your shell isn't used unless you name it:
`KINDGI_DEV_GOOGLE_CREDENTIALS=$GOOGLE_APPLICATION_CREDENTIALS`.

## 2. Register the preset

Register the preset's models with the runtime:

```sh
kindgi providers register --preset=gemini --project=<gcp-project>
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
kindgi providers register --preset=gemini --project=<gcp-project> --models=gemini-3.8-flash
```

```text
{
  "providerId": "gemini"
}
✓ Registered gemini: gemini-3.8-flash (default)
```

The preset's models answer with up to 65,536 tokens, thinking included.
`--max-output-tokens=<n>` registers them with another limit, `<n>` tokens.

To have `kindgi dev` register it on every boot, declare it in the pack's config
instead: `{ preset: 'gemini', project: '<gcp-project>' }` in
`kindgi.config.ts`'s `providers`, or a `[[tool.kindgi.providers]]` table with
`preset = "gemini"` and `project = "<gcp-project>"` in `pyproject.toml`.
[Declare them in your pack's config](../#declare-them-in-your-packs-config)
shows how.

## What it registers

Get the provider by its id to see what it registered:

```sh
kindgi providers get gemini
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

## If you registered Gemini 2.5

An earlier preset registered `gemini-2.5-pro` and `gemini-2.5-flash`.
Vertex AI retires both on **2026-10-20**. After that, a turn routed to them
fails. Move to the current CLI, then:

- **A provider you registered with `kindgi providers register`:** unregister
  it and register the preset again. A registration can't be edited:

  ```sh
  kindgi providers unregister gemini
  kindgi providers register --preset=gemini --project=<gcp-project>
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
[Deploy on Google Cloud Run](../../../deploy/cloud-run/#use-gemini) sets this up.

## Next

- [Choose the model an agent uses](../../agents/choose-a-model/)
- [Deploy on Google Cloud Run](../../../deploy/cloud-run/#use-gemini)
- [Models](../)
