---
"@kindgi/api": patch
---

**The event streams for runs, eval runs and secret rotations stop their work as soon as the reader goes away, and a `HEAD` on one starts none of it.**

Each of these server-sent-events routes starts its work when it opens the stream. Before this change, nothing stopped that work when the reader went away, for example when a client disconnected. Hono answers a `HEAD` with the `GET` route and drops the body without cancelling it, so every `HEAD` started the same work. The work then ran to its own end:
- `GET /v1/runs/{runId}/stream` and `/progress/stream`: a journal read every 200 ms, or an event-bus subscription, until the run's terminal event or five minutes.
- `GET /v1/eval-runs/{runId}/events`: a read of the eval run every 100 ms, until it ends or five minutes.
- `GET /v1/secrets/{name}/rotations/{rotationId}/events`: a subscription to the rotation's status and a heartbeat every 15 s, for as long as the rotation stays `pending`, with no time limit.

Each stream now stops when its reader cancels it:
- the poll and its wait end at once, and so does the five-minute wait;
- the subscription ends, and the heartbeat stops;
- a reader that cancels while the run's journal is still being read back doesn't subscribe at all.

A `HEAD` answers with the stream's status and headers (`200`, or the `GET`'s `404`) and doesn't start the stream. A reader that stays connected receives the same events as before.
