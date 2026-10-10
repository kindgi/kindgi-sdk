---
"@kindgi/capabilities": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/api": patch
---

**A model call can carry a `traceparent`, and the three model adapters send it to the vendor.**
- **`ModelCallInput.traceparent?`** (optional) is a W3C `traceparent` for the call.
- **The adapters** send it as the `traceparent` header on that request, and only when it's set:
  - anthropic, through its request options (on the SDK's retries too);
  - openai-compat, on both the Chat Completions and Responses paths;
  - gemini, through the request's `httpOptions.headers`.
  It's never in the body and never logged, and an adapter never makes one up.
- **A runtime sets it only for a provider whose registration opts in.** Trace ids leave the process only on opt-in.
- **`ResumeRunBindingInput.trace?`:** the approval that resumes a run passes its request's trace context, as starting a run does.
