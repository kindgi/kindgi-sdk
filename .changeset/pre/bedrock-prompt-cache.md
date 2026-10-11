---
"@kindgi/adapter-model-bedrock": patch
"@kindgi/adapter-model-shared": patch
---

**The Bedrock adapter caches prompts.** Bedrock caches only the prefixes a request marks, so the adapter now marks them, for Claude and Nova models whose registration prices cache reads: a cache point after the system prompt, and after the last message when the call will be sent again (a call with tools, or a conversation with an earlier answer). Other models get none. Cache reads and writes are priced at the model's registered multipliers, as before.
- `createAiSdkModelProvider` takes a `cacheMark` option: the provider options that mark a prompt message for a model, or none.
