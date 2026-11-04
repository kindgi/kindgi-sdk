---
"@kindgi/api": patch
---

**A chat app's request to `/mcp` counts once toward the workspace's API requests a minute.**

- A tool call that starts a run and waits for it, or one wait with `kindgi.run_state`, is one request however often it reads the run. The `/v1` requests the tools make for it count on that one, up to 40 for each message. Past that, each counts as any request does.
- Every message counts, including ones that read nothing, such as `initialize` and `ping`. A batch counts each of its messages.
- Past the limit, a tool call answers that Kindgi is busy and when to try again, and starts nothing. Any other request to `/mcp` gets `429 rate-limit-exceeded` with `Retry-After`, as `/v1` does.
