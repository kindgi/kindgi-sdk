---
"@kindgi/client": patch
---

**The Python client follows a run to its end: `runs.follow(run_id)` and `runs.follow_progress(run_id)`, sync and async.**
- **Why:** the server ends a run's stream after its terminal event or after 5 minutes. `runs.stream` ended there too, so a run that took longer, waiting for an approval say, stopped streaming early unless the caller reconnected.
- **What they do:**
  - reconnect with `Last-Event-Id` until `run.completed`, `run.failed` or `run.cancelled`, each event once;
  - pause 0.5 s before reconnecting after a connection that brought nothing;
  - retry a dropped connection, a 429 or a 502–504 with backoff (0.5 s up to 30 s, 10 attempts in a row);
  - raise any other error, such as a 404;
  - end after the terminal event, even if the server keeps the connection open.
- **The pair** matches TypeScript's `runs.stream` and `runs.streamProgress` and the Java client's `runs().follow` and `runs().followProgress`.
- **`runs.stream`** stays the plain call.
