---
"@kindgi/agents": patch
---

**A worker template renderer's `close()` now always settles.** Idle render workers are unref'd so they don't hold the process up, which left a race: on a shutdown where `await renderer.close()` was the last thing keeping the event loop alive, the loop could drain and the process exit before the workers' exit settled the promise — so `close()` never resolved and a top-level `await` on it saw the process leave with a non-zero exit. `close()` now holds the loop with a ref'd timer across the stop phase, bounded so it can't outlast the workers; and a worker that doesn't stop on `SIGTERM` within a one-second grace is `SIGKILL`'d, so `close()` can never hang on one. Running renders are unaffected: `close()` lets them finish before any worker is stopped.
