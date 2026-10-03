---
"@kindgi/sdk": patch
---

`kindgi-authoring-providers`: an OpenAI-compatible provider works (the runtime registers the adapter); a keyless endpoint such as Ollama needs no placeholder `secret_ref`; and what a model you serve yourself must do for an agent: tool calling on, thinking off (on the server, or per request with `extraBody.*` keys in `adapter_config`).
