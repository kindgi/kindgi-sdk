---
"@kindgi/sdk": patch
---

**The tools skills say what bounds an HTTP tool's call.** The TypeScript and Python tools skills say that `timeoutMs` (`timeout_ms`) and a run's cancel cover reading the response, and that a response body over 10 MiB, counted after it's decompressed, fails the call. So they point a tool at an endpoint that pages or filters.
