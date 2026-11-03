# Path C — Local via in-process ONNX (runtime from source only)

> ⚠️ **Not in the runtime image, so not under `kindgi dev`.** The adapter
> runs ONNX through `onnxruntime-node`, which ships glibc binaries only,
> and the Kindgi runtime image is Alpine (musl): the adapter can't load
> there (`Error loading shared library ld-linux-…`). `kindgi dev` runs
> that image, so this path fails under it. It works only when the
> runtime itself runs from source on macOS or a glibc Linux. **For a
> local model under `kindgi dev`, use Ollama** (`path-b-openai-compat.md`).

> ⚠️ **Dev-only.** The in-process ONNX adapter writes weights to
> `~/.cache/huggingface/hub/` — a per-machine cache with no production
> recipe (no volume-mount recipe, no image-bake pattern, no offline
> mode, no SHA pinning). Good for smoke tests and CI runners that run
> the runtime from source and keep the same disk between runs. **Do not
> ship packs that rely on this adapter to production.** Use hosted
> providers (Path A) or Ollama (Path B) instead.

No API key. No network. Bundled with the framework — the adapter ships
`smollm2-360m` by default (~273 MB weights, cached at
`~/.cache/huggingface/hub/models--HuggingFaceTB--SmolLM2-360M-Instruct/`
after `kindgi adapters prepare`).

**Not for reasoning-heavy agents.** SmolLM 360M is fine for smoke
tests, canary agents, dev/CI. Real work needs a hosted model or a
larger local model via Ollama (Path B).

**`provider.json`** (single-model):
```json
{
  "metadata": {
    "id": "local-onnx",
    "region": "in-process",
    "models": [
      {
        "name": "smollm2-360m",
        "contextWindow": 2048,
        "features": ["tool-use"],
        "cost": {
          "promptUsdPer1kTokens": 0,
          "completionUsdPer1kTokens": 0
        }
      }
    ],
    "description": "Local ONNX smollm2-360m — dev + smoke tests."
  },
  "adapter_id": "@kindgi/adapter-model-in-process"
}
```

Multi-model variant — the in-process adapter loads each pipeline lazily,
so listing several models keeps memory low until they're actually
invoked:

```json
{
  "metadata": {
    "id": "local-onnx",
    "region": "in-process",
    "models": [
      { "name": "smollm2-135m", "contextWindow": 2048, "features": [],
        "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } },
      { "name": "smollm2-360m", "contextWindow": 2048, "features": ["tool-use"],
        "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } },
      { "name": "qwen3-0.6b", "contextWindow": 32768, "features": ["tool-use", "long-context"],
        "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } }
    ]
  },
  "adapter_id": "@kindgi/adapter-model-in-process"
}
```

No `secret_ref` needed. Register + **prepare** + run:
```sh
kindgi providers register --spec=@provider.json
kindgi adapters prepare @kindgi/adapter-model-in-process --model=smollm2-360m
kindgi runs start --agent=<agent-id> --input='{...}'
```

**Always `prepare` before `runs start`.** It downloads the ONNX weights
(~273 MB for smollm2-360m, ~30s on a typical connection) and streams
per-file progress. Skipping it works — the first model call downloads
lazily — but that stalls a request path on a multi-hundred-MB
fetch with no observability, which is bad in dev and unacceptable in
production. Skip only for scripted teardown where the model is already
cached (`~/.cache/huggingface/hub/models--HuggingFaceTB--SmolLM2-360M-Instruct/`).

`prepare` is idempotent: subsequent invocations are cache hits and
return almost instantly, so put it in the script that boots your
from-source runtime.

Multi-model providers: prepare each model separately.
```sh
kindgi adapters prepare @kindgi/adapter-model-in-process --model=smollm2-135m
kindgi adapters prepare @kindgi/adapter-model-in-process --model=smollm2-360m
kindgi adapters prepare @kindgi/adapter-model-in-process --model=qwen3-0.6b
```
