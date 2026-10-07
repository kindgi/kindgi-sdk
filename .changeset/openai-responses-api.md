---
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/cli": patch
---

OpenAI's GPT-6 models can call tools: the OpenAI-compatible adapter now speaks OpenAI's Responses API to OpenAI itself. GPT-6 Astra and Sol can't call tools through Chat Completions, and Luna only without reasoning, so an agent with tools on the `openai` preset failed.
- **Which API:** a provider's `adapter_config.api` picks it, `responses` or `chat-completions`. Without one, a `baseURL` on `api.openai.com` (or a data-residency host such as `eu.api.openai.com`) speaks Responses, and every other endpoint (Ollama, vLLM, Groq, OpenRouter, …) keeps Chat Completions. **An existing OpenAI registration moves to Responses on upgrade, with no re-registration:** set `adapter_config.api` to `chat-completions` to keep the old path. A registration whose `extraBody.*` fields were written for Chat Completions (such as `extraBody.reasoning_effort`) either keeps that path the same way, or moves them to their Responses names (`extraBody.reasoning.effort`).
- **The `openai` preset** sets `api: responses`.
- **Stateless:** every Responses call sends `store: false`, so OpenAI keeps no conversation state for Kindgi's calls. A reasoning model's reasoning between tool calls goes back to it with the calls (in the tool call's `signature`), for the same model only.
- **`extraBody`** on Responses refuses the fields the adapter sets there (`EXTRA_BODY_RESERVED_RESPONSES`); `extraBody.reasoning.effort` sets a reasoning model's effort.
- **The model data applies on Responses too:** a temperature the model doesn't take (`sampling: false`) isn't sent and the answer carries a `sampling-unsupported` warning; a call asking for `thinking: 'lowest'` (a guardrail judge) sends the model's lowest `reasoning.effort` (`gpt-6-astra` now has one: `low`, checked live; `none` is refused); and the system prompt names the call's tools as they're sent.
