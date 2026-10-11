---
"@kindgi/types": patch
"@kindgi/tools": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-gemini": patch
---

**A secret that can't go in a header is refused by its name, never quoted.** When a header value has a line break or a NUL inside it, fetch refuses it with an error that quotes the whole value (`Headers.append: "<value>" is an invalid header value.`). A secret pasted with its next line ended up, whole, in the error. For a declarative HTTP tool, that error became the tool call's failure message, stored with the run and its journal. For a model adapter, it was the model call's failure, and so in the logs.
- **HTTP tools (`spec: { kind: 'http' }`):** the resolved secret (`bearer` or `header`) is checked before the request. A bad one fails the call with `http-tool "<id>": its secret <env>/<name> for the header "<header>" has a line break, which a header can't carry: store the secret without it`. Headers filled from the input are checked the same way, by name.
- **Model adapters (Anthropic, OpenAI-compatible for chat, Responses and embeddings, Gemini):** the resolved API key is checked on every call, before a client is built or reused: `<adapter>: provider "<id>": its API key has a line break, which a header can't carry: store the secret without it`.
- **What still works:** a trailing line break is fine, since fetch drops it, and so is a tab or a Latin-1 character. Other control characters, which the request refuses anyway, are refused here by name too.
- **New in `@kindgi/types`:** `headerValueProblem(value)`, the rule all of these use.
- **Records made before:** a failure message already stored keeps what it recorded. Rotate a secret that was ever pasted with a line break.
