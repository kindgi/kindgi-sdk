---
"@kindgi/adapter-model-gemini": patch
---

A Gemini call that gets nothing back (a dropped or refused connection, DNS, TLS) throws `ModelProviderError` with `kind: 'network'` and no `status`, as the other adapters' do, and says why. It used to throw the `@google/genai` client's own error, which said only `fetch failed` and left the reason in its `cause`. Its message is now the client's words with what their causes add, masked as a tool error's are, for example `fetch failed; caused by AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:443, connect ECONNREFUSED 127.0.0.1:443`, and the client's error is its `cause`. A connection the runtime refuses (its egress or body-size rule) says the refusal's own words. Code that checked the thrown error for a `TypeError`, or for the message `fetch failed`, checks `cause` instead. An abort, a response that refuses the call, and what is retried are unchanged.
