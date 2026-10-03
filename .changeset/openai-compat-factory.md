---
"@kindgi/adapter-model-openai-compat": minor
---

The runtime can register OpenAI-compatible providers: `openAICompatAdapterFactory` (`OPENAI_COMPAT_ADAPTER_ID`) takes the endpoint from `adapter_config.baseURL` and the key from `secret_ref`, resolved on every call (`apiKey` now also takes a resolver; the client is rebuilt when the key rotates; without a secret the adapter sends a placeholder, as local runners expect). `invoke()` passes the turn's abort signal to the request, so a cancelled turn cancels the call.
