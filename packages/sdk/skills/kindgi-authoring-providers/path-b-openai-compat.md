# Path B — Hosted via OpenAI-compat

## Contents

- Step 1 — set the key
- Step 2 — `provider.json`
- Steps 3 to 5 — register, verify, run
- Local via Ollama
- Any model you serve yourself

Works with **any** OpenAI-compatible endpoint. Same adapter, different
`baseURL`:

| Provider | baseURL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| LiteLLM proxy | `http://localhost:4000/v1` |
| OpenRouter (a hosted gateway) | `https://openrouter.ai/api/v1` |

The connection carries the `baseURL` (in `adapter_config`);
each endpoint is a separate provider row because each has its own API
key + region. Within one row, list every model that endpoint exposes.

**Step 1 — set the key:**
```sh
kindgi secrets set GROQ_API_KEY --env=local --scope=tenant
# Interactive prompt; paste and enter.
```

**Step 2 — `provider.json`** (Groq, exposing two Llama variants):
```json
{
  "metadata": {
    "id": "groq",
    "region": "us-central-1",
    "models": [
      {
        "name": "llama-3.3-70b-versatile",
        "contextWindow": 128000,
        "features": ["tool-use"],
        "cost": {
          "promptUsdPer1kTokens": 0.00059,
          "completionUsdPer1kTokens": 0.00079
        }
      },
      {
        "name": "llama-3.1-8b-instant",
        "contextWindow": 128000,
        "features": ["tool-use"],
        "cost": {
          "promptUsdPer1kTokens": 0.00005,
          "completionUsdPer1kTokens": 0.00008
        },
        "description": "Fast + cheap tier — routing, classification."
      }
    ],
    "description": "Groq-hosted Llama via OpenAI-compat."
  },
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "secret_ref": { "envName": "local", "name": "GROQ_API_KEY" },
  "adapter_config": { "baseURL": "https://api.groq.com/openai/v1" }
}
```

**Steps 3 to 5 — register, verify, run:**
```sh
kindgi providers register --spec=@provider.json
kindgi providers list
```
Then run an agent whose `capabilities.needs` one of the listed models'
`features` satisfy. Registering the same id again returns
`provider-already-registered`: unregister first when the config changed
(mistake 5 in `common-mistakes.md`).

## Local via Ollama

For bigger local models — Ollama runs them, we point at the OpenAI-compat
endpoint it exposes:

```json
{
  "metadata": {
    "id": "ollama",
    "region": "local",
    "models": [
      {
        "name": "llama3",
        "contextWindow": 8192,
        "features": ["tool-use"],
        "cost": {
          "promptUsdPer1kTokens": 0,
          "completionUsdPer1kTokens": 0
        }
      }
    ],
    "description": "Local Ollama Llama 3 8B."
  },
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "adapter_config": { "baseURL": "http://localhost:11434/v1" }
}
```

Ollama doesn't check a key, so the row has no `secret_ref`: without one,
the adapter sends a placeholder key, as local servers expect.

**Any model you serve yourself** (Ollama, vLLM, llama.cpp's
`llama-server`, LM Studio) must do two things for an agent:
- **Call tools in the OpenAI format.** Serve it with tool calling on
  (vLLM `--enable-auto-tool-choice --tool-call-parser <the model's>`,
  `llama-server --jinja`), and pick a model that supports tools.
- **Answer without its thinking.** A thinking model (Qwen and others)
  writes its reasoning first unless asked not to, and a typed answer then
  isn't JSON (`output-schema-violation`). Turn thinking off on the server
  (vLLM `--default-chat-template-kwargs '{"enable_thinking": false}'`,
  `llama-server --reasoning off`), or, for a shared server you can't
  reconfigure, per request from the provider row:
  `"extraBody.chat_template_kwargs.enable_thinking": false` in
  `adapter_config`. `adapter_config` is flat: one key per request field,
  dots nest.

Assumes Ollama is installed + the model is pulled (`ollama pull llama3`).
See ollama.com for install / hardware requirements — Llama 3 8B needs
~8GB RAM, Llama 3 70B needs ~48GB VRAM or ~140GB RAM.
