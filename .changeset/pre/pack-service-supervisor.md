---
"@kindgi/handler-runtime": minor
---

`createPackServiceSupervisor` runs the pack service as a local child process behind a stable front: one loopback address and session token for the supervisor's life, forwarding to whichever child serves (code swaps on `start`, the previous child drains, a failed boot keeps the old one, a crashed child restarts). Forwarding is a separate `relay` (request body plus deadline, run and request ids, protocol version, and a cancel signal), reusable by other listeners. A retiring child gets its full drain (`PACK_SERVICE_DRAIN_MS`, 8 s) plus 2 s before it is killed, so a call it would still finish is never cut off.

`pack-service-main` takes `--host <address>` (default: every interface). Stopping the pack service now also closes connections left by callers that went away mid-call, which used to hold shutdown for several seconds.
