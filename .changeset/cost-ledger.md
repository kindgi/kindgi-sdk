---
"@kindgi/capabilities": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/agents": patch
"@kindgi/guardrails": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

Every model call is recorded, with everything the provider says about it, and the cost API reads it per call, per run tree, and per org.

- **Usage recording.** The agent turn records each model call in a usage sink (`InvokeAgentBindings.usage`, `UsageSink` / `ModelUsageRecord` in `@kindgi/capabilities`) before the step goes on, a call that threw included. The record carries the call id, project, run, agent and version, step, provider, the model actually called, a fallback flag, status, usage, duration and finish reason. llm-judge guardrails record theirs too (`EvaluationBindings.usage`, `purpose: guardrail-judge:<id>`). A dry run records nothing.
- **Usage, unfolded.** `UsageCounters` reports the parts of its totals: `cacheReadTokens` and `cacheWriteTokens` are parts of `promptTokens`, `reasoningTokens` of `completionTokens`. `ModelCallResult` adds `servedModel` (the exact version the vendor reports), `providerRequestId`, `attempts` (HTTP attempts, the SDK's own retries included, counted with `createAttemptCounter`) and `rawUsage` (the vendor's usage object as it reported it). The Anthropic, Gemini and OpenAI-compatible adapters fill them.
- **Breaking, for a custom model adapter:** `UsageCounters.cachedTokens` is renamed `cacheReadTokens`.
- **Cost API (`@kindgi/api`, `@kindgi/client`).** A cost record of a model call carries `callId`, `projectId`, `rootRunId`, `parentRunId`, `agentVersion`, `flowId`, `nodeId`, `step`, `purpose`, `model`, `servedModel`, `fallback`, `status`, `usage`, `durationMs`, `finishReason`, `providerRequestId`, `attempts` and `error`, and `rawUsage` with `include=rawUsage`. New filters: `model`, `servedModel`, `rootRunId`, `includeDescendants` (with `runId`). New `groupBy` dimensions: `model`, `servedModel`, `projectId`, `orgId`, `rootRunId`, `flowId`. Every aggregate group and the total carry `tokens: {prompt, completion, cacheRead, cacheWrite, reasoning}`. A binding that fails answers 500, never an empty page. `to` is exclusive, as the binding always applied it. The TypeScript client takes `scope`, the new filters and `includeRawUsage`.
- **`run.finished`** carries `usage: {calls, costUsd, tokens}` for the whole run tree, when the runtime records usage.
- **Provenance (breaking for readers of `model-call` attributes):** a `model-call` node keeps the call's identity (`callId`, `providerId`, `model`, `finishReason`, `step`); its `promptTokens`, `completionTokens` and `costUsd` are gone from `attributes`. A provenance read carries them in `callUsage`, by `callId`, from the cost ledger, outside the signed DAG (`ProvenanceBinding.getCallUsage`). A signed export includes `callUsage` as it stood when signed (bundle schema `1.1.0`).
