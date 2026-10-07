---
title: Connect Gemini on Vertex AI
description: Register Gemini from the gemini preset, using your Google Cloud credentials instead of an API key.
sidebar:
  order: 2
---

The `gemini` preset registers Gemini 3.8 Flash and Gemini 3.5 Flash Lite on
Google Cloud's Vertex AI. It takes no API key: calls use your Google Cloud
credentials, and Vertex AI runs and bills them in a project you name.

## 1. Log in to Google Cloud

```sh
gcloud auth application-default login
```

That writes your Application Default Credentials. `kindgi dev` hands them to
the runtime it starts, read-only: the file `GOOGLE_APPLICATION_CREDENTIALS`
names, if it's set, else the one this command writes
(`~/.config/gcloud/application_default_credentials.json`). The account needs
access to Vertex AI in the project.

## 2. Register the preset

```sh
kindgi providers register --preset=gemini --project=<gcp-project>
```

`--project` is the Google Cloud project Vertex AI runs and bills in; the preset
refuses to register without it:

```text
Error: preset "gemini" needs --project=<…> (The Google Cloud project Vertex AI bills and authorises against.)
```

`--models` registers only some of the models:

```sh
kindgi providers register --preset=gemini --project=<gcp-project> --models=gemini-3.8-flash
```

The preset's models answer with up to 65,536 tokens, thinking included.
`--max-output-tokens=<n>` registers them with another limit.

To have `kindgi dev` register it on every boot, declare it in the pack's config
instead: `{ preset: 'gemini', project: '<gcp-project>' }` in
`kindgi.config.ts`'s `providers`, or a `[[tool.kindgi.providers]]` table with
`preset = "gemini"` and `project = "<gcp-project>"` in `pyproject.toml`. See
[Declare them in your pack's config](../#declare-them-in-your-packs-config).

```text
{
  "providerId": "gemini"
}
✓ Registered gemini: gemini-3.8-flash
```

## What it registers

```sh
kindgi providers get gemini
```

The provider's id is `gemini` and its region `global`, where Vertex AI serves
Gemini 3.8 Flash (it isn't served from `us-central1`). Both models list
`tool-use`, `structured-output` and `long-context`:

| Model | Context window | Per 1K input / output tokens |
| --- | --- | --- |
| `gemini-3.8-flash` | 1,048,576 | $0.00075 / $0.00375 |
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
`preferredProvider: 'gemini'` (`preferred_provider="gemini"` in Python), or
require it: see [Choose the model an agent uses](../../agents/choose-a-model/).

## If you registered Gemini 2.5

Earlier releases' preset registered `gemini-2.5-pro` and `gemini-2.5-flash`.
Vertex AI retires both on **2026-10-20**; after that, a turn routed to them
fails. Move to this release's CLI, then:

- **A provider you registered with `kindgi providers register`:** unregister
  it and register the preset again (a registration can't be edited):

  ```sh
  kindgi providers unregister gemini
  kindgi providers register --preset=gemini --project=<gcp-project>
  ```

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
service account (on Cloud Run, the service's). That account needs
`roles/aiplatform.user` in the project, and the project needs the Vertex AI
API turned on. Without the role, every model call fails with
`Permission 'aiplatform.endpoints.predict' denied`.
[Deploy on Google Cloud Run](../../../deploy/cloud-run/#use-gemini) sets this up.
