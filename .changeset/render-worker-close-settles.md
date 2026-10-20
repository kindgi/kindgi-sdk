---
"@kindgi/agents": patch
---

**A worker template renderer's `close()` no longer fails to settle after its renders finish.** Idle render workers are unref'd so they don't hold the process up, which left a race: once the running renders had ended, if `await renderer.close()` was the last thing keeping the event loop alive, the loop could drain and the process exit before the workers' exit settled the promise — so `close()` never resolved and a top-level `await` on it saw the process leave with a non-zero exit. Stopping a worker now holds the loop with its own ref'd timer until the worker is gone: `SIGTERM`, then `SIGKILL` a second later if it hasn't stopped, then give up a second after that — so the stop settles within two seconds and can neither drain the loop early nor hang on a wedged worker. Running renders are unaffected: `close()` still lets them finish before any worker is stopped.
