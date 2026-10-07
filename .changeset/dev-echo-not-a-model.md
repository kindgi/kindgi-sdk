---
"@kindgi/dev-echo-provider": patch
"@kindgi/capabilities": patch
"@kindgi/agents": patch
"@kindgi/cli": patch
"@kindgi/adapter-model-gemini": patch
---

**dev-echo says it isn't a model, and there are presets for more LLM provider keys.**

- **dev-echo's text answers start with one line:** "⚠ dev-echo isn't a real model: it only repeats what it's given. Add an LLM provider key (Anthropic, OpenAI, Gemini, Groq, OpenRouter…) to get real answers." So a developer can't mistake it for a model wherever the answer shows, their own app included. An answer that is JSON (what a typed-output agent parses) stays bare, as does one asked for with `structuredOutput`.
- **Every dev-echo result carries a warning, `dev-echo-not-a-model`,** with the commands that add a model. `ModelCallResult.warnings` (new, optional) lets any provider warn about its answers. An agent turn collects them into its result's `warnings`, a resumed turn too, and `kindgi runs start` prints them on stderr. dev-echo's own warning stands in for the `fallback-provider` one there.
- **New presets for key-based LLM providers:**
  - `openai` (`OPENAI_API_KEY`), `groq` (`GROQ_API_KEY`) and `openrouter` (`OPENROUTER_API_KEY`, many vendors' models with one key), on the OpenAI-compatible adapter;
  - `gemini-api` (`GEMINI_API_KEY`), Gemini with a Google AI Studio key.

  A preset can now fix adapter settings itself (`adapterConfigValues`, such as the `baseURL`).
- **`@kindgi/adapter-model-gemini` takes a Gemini Developer API key** (`apiKey`, or `adapter_config.api: "developer"` with the key as `secret_ref`), next to Vertex AI. Vertex stays the default and the `gemini` preset, the route for a regulated deployment.
- **`kindgi doctor`** looks for every preset's key, and its fixes offer any one of them: the key to set, and the preset to register.
- **The init templates** ask for "an LLM provider key" (Anthropic, OpenAI, Gemini, Groq or OpenRouter), not Claude's alone.
