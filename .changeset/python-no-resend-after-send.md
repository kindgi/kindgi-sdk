---
"@kindgi/client": patch
---

**The Python client no longer starts a waited run more than once.**

**What happened since 0.1.2:** a waited `runs.start` whose run took longer than the client's timeout (60 s by default) was sent again with the same idempotency key, up to twice. The runtime started the run again each time: up to three runs, each with its tools' side effects. The caller got a `NetworkError` and no run id. Any other slow call with an idempotency key was exposed the same way. The TypeScript client never sends a call again, so it wasn't affected.

**Now:**
- **Which calls are sent again:** a call other than a GET only when nothing can have run: a failure to connect (or a connect or pool timeout), or a 429 or 503. A read timeout, a dropped connection, or a proxy's 502 or 504 is raised at once. A GET is retried as before.
- **A waited `runs.start` that times out** raises a `NetworkError`. It says the run may still be going and its id didn't arrive. It also says to start a run that can take longer with `options={"wait": False}` and follow it with `runs.stream` or `runs.get`.
- **A call the timeout ended** gets a `NetworkError` that carries `timeout`, in seconds.
