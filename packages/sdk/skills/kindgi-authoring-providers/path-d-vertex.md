# Path D — Gemini on Vertex AI

Gemini through Google Cloud's Vertex AI. No API key: the adapter uses
**Google Application Default Credentials** — your `gcloud` login on a
laptop, the attached service account on Cloud Run (and other Google Cloud
runtimes). The same registration works in both.

**Step 1 — credentials:**
```sh
gcloud auth application-default login     # once per laptop
```
The account (locally) or the service account (deployed) needs the
**Vertex AI User** role (`roles/aiplatform.user`) in the project. Running
outside Google Cloud: put a service-account key (its JSON) in a secret
(`kindgi secrets set GEMINI_SA_KEY --env=local --scope=tenant`) and add
`"secret_ref": { "envName": "local", "name": "GEMINI_SA_KEY" }`. A runtime
with `KINDGI_TENANT_HOST_ACCESS=isolated` requires that key: it doesn't lend
its own credentials to tenant configuration.

**Step 2 — `provider.json`:**
```json
{
  "metadata": {
    "id": "gemini",
    "region": "global",
    "models": [
      {
        "name": "gemini-3.8-flash",
        "contextWindow": 1048576,
        "features": ["tool-use", "structured-output", "long-context"],
        "maxOutputTokens": 65536,
        "thinking": { "mode": "adaptive", "lowest": "low" },
        "cost": { "promptUsdPer1kTokens": 0.00075, "completionUsdPer1kTokens": 0.00375 }
      },
      {
        "name": "gemini-3.5-flash-lite",
        "contextWindow": 1048576,
        "features": ["tool-use", "structured-output", "long-context"],
        "maxOutputTokens": 65536,
        "thinking": { "mode": "adaptive", "lowest": "minimal" },
        "cost": { "promptUsdPer1kTokens": 0.0003, "completionUsdPer1kTokens": 0.0025 }
      }
    ]
  },
  "adapter_id": "@kindgi/adapter-model-gemini",
  "adapter_config": { "project": "<your-gcp-project-id>" }
}
```
- `adapter_config.project` is required: the Google Cloud project Vertex
  bills and authorises against.
- `metadata.region` is the Vertex location: `global`, or a region such as
  `us-central1` or `northamerica-northeast1` when data must stay in one
  place. `unspecified` means `global`. Different locations are different
  provider rows. Check that the location serves the model: Gemini 3.8 Flash
  isn't served from `us-central1`.
- Don't register `gemini-2.5-pro` or `gemini-2.5-flash`: Vertex AI retires
  both on 2026-10-20.
- Rates are per 1K tokens, from Google's published pricing; check them
  before relying on budgets. Thinking tokens bill as output, and Gemini 3.8
  Flash thinks by default. `gemini-3.8-flash`'s rates above are Google's
  launch price, through 2026-12-31 ($0.0015 / $0.0075 from 2027-01-01).
  `longContext` (`{ thresholdTokens, promptUsdPer1kTokens,
  completionUsdPer1kTokens }` in a model's `cost`) switches the whole call
  to the higher rates past the threshold; `cachedPromptMultiplier` (default 0.25) prices cached
  prompt tokens.
- `thinking` is how the model thinks, as the preset has it. `lowest` is
  the least level it takes, which a judge's call asks for. `levels`
  (optional) are the levels it takes besides `lowest`, least first; without
  them it takes `low`, `medium` and `high` (plus `minimal` when `lowest` is
  `minimal`, and none below `lowest` when that's `medium` or `high`).
- To make a model think less, the agent sets `thinking` in its model
  settings (`lowest`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
  For calls that ask none, set the model's `thinking.default`:
  `"thinking": { "mode": "adaptive", "lowest": "low", "default": "low" }`.
  A `default` the model doesn't take is refused, naming the ones it takes.
  A model without one thinks as Google sets. It needs runtime 0.3.0 or
  later; an older one refuses a `thinking` with `default`.
- `adapter_config.thinkingLevels` is no longer read. A new registration
  with it is refused (`adapter_config.thinkingLevels isn't read here: its
  setting is metadata.models[].thinking.default.`); a stored one builds,
  thinking at Google's default, and `kindgi doctor` warns. Move each
  `model=level` pair into that model's `thinking.default`, unregister the
  provider and register it again.

**Step 3 — register and check:**
```sh
kindgi providers register --spec=@provider.json
kindgi providers list
```
Or skip step 2: `kindgi providers register --preset=gemini --project=<your-gcp-project-id>`
registers both models above.
Then pin it from an agent with `preferredProvider: 'gemini'` (and a model
with `preferredModel`; in Python, `preferred_provider="gemini"` and
`preferred_model=…`; in Java, `.set("preferredProvider", "gemini")`), or let
the router pick by capability.
