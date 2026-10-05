---
title: Connect Gemini on Vertex AI
description: Register Gemini from the gemini preset, using your Google Cloud credentials instead of an API key.
sidebar:
  order: 2
---

The `gemini` preset registers Gemini 2.5 Pro and Gemini 2.5 Flash on Google
Cloud's Vertex AI. It takes no API key: calls use your Google Cloud
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
kindgi providers register --preset=gemini --project=<gcp-project> --models=gemini-2.5-flash
```

```text
{
  "providerId": "gemini"
}
✓ Registered gemini: gemini-2.5-flash
```

## What it registers

```sh
kindgi providers get gemini
```

The provider's id is `gemini` and its region `global`. Both models list
`tool-use` as their only feature:

| Model | Context window | Per 1K input / output tokens |
| --- | --- | --- |
| `gemini-2.5-pro` | 1,048,576 | $0.00125 / $0.01 |
| `gemini-2.5-flash` | 1,048,576 | $0.0003 / $0.0025 |

An agent that needs `structured-output` or `long-context` doesn't route to
them. To send an agent to Gemini when other providers are registered too, set
`preferredProvider: 'gemini'` (`preferred_provider="gemini"` in Python), or
require it: see [Choose the model an agent uses](../../agents/choose-a-model/).

## From a deployed runtime

A deployed runtime has no login of yours: it calls Vertex AI as its own
service account (on Cloud Run, the service's). That account needs
`roles/aiplatform.user` in the project, and the project needs the Vertex AI
API turned on. Without the role, every model call fails with
`Permission 'aiplatform.endpoints.predict' denied`.
[Deploy on Google Cloud Run](../../../deploy/cloud-run/#use-gemini) sets this up.
