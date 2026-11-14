---
"@kindgi/adapter-model-shared": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-azure-openai": patch
"@kindgi/adapter-model-bedrock": patch
---

A model call that gets nothing back (a dropped or refused connection, DNS, TLS) now says why, in the Anthropic, OpenAI-compatible, Azure OpenAI and Bedrock adapters. It used to say only `fetch failed`, `Cannot connect to API: ` or `Connection error.`, and left the reason in the error's `cause`. Now its causes follow the message, as a tool's error says them, for example `Cannot connect to API; caused by AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:443, connect ECONNREFUSED 127.0.0.1:443`. Each cause is masked as a tool error's is, and a reason the message already holds isn't said twice. A vendor's answer, the error's `kind` and `status`, and what is retried are unchanged. `@kindgi/adapter-model-shared` now exports `withCauses`, the one way its adapters say it, and depends on `@kindgi/log`.
