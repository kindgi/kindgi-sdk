---
"@kindgi/capabilities": patch
"@kindgi/api": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/cli": patch
---

**A model that rejects `temperature` no longer fails the call.** Anthropic's Claude 4.7 and later (Opus 5.5, Sonnet 5.5, Haiku 5.5) answer a non-default `temperature` with a 400, and OpenAI's GPT-6 models take none at their reasoning efforts. A model's `ModelInfo` now says so with `sampling: false`. For such a model, every adapter sends the call without the temperature and says so in the answer's `warnings`, code `sampling-unsupported`. That covers a model-settings block, a guardrail judge and an eval judge alike.
- `@kindgi/capabilities`: `ModelInfo.sampling`, and `samplingFor(model, input)`, the one place an adapter asks what to send.
- The HTTP API keeps a model's `sampling` (it must be a boolean; otherwise 400, reason `invalid-sampling`) and returns it. The Python client's `ModelInfo` has it too.
- The `anthropic`, `openai` and `openrouter` presets mark those models. A registration made from an older preset keeps sending the temperature: re-register to pick up the marks.
