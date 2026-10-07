---
"@kindgi/cli": patch
---

Provider presets follow the providers' model lifecycles:
- **`gemini` (Vertex AI):** `gemini-3.8-flash` and `gemini-3.5-flash-lite`, in place of `gemini-2.5-pro` and `gemini-2.5-flash`, which Vertex AI retires on 2026-10-20 (Google names 3.8 Flash as their replacement). Region `global`, as before.
- **`gemini` and `gemini-api`:** `gemini-3.8-flash` and `gemini-3.5-flash-lite` declare `structured-output`, so an agent that needs it (`capabilities: [{ needs: [{ feature: 'structured-output' }] }]`) can route to them. Both were checked with typed output on Vertex AI.
- **`anthropic`:** `claude-haiku-4-5` is marked as retiring on or after 2026-10-15. Pin another model before then.

A registration from an older preset keeps its models: re-register (`kindgi providers register --preset=gemini --project=<id>`) to move to the new ones.
