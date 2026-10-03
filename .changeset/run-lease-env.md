---
"@kindgi/env-schema": patch
---

**The executor lease's timings, for operators.** The runtime fails a run whose server stopped without a shutdown (killed, out of memory, a crash) once the run's lease runs out, and sends `run.finished`. Two `core` variables set how fast:

- `KINDGI_RUN_LEASE_MS`: how long a run's lease lasts without renewal (default 300000, 5 minutes; at least 10000). The server executing the run renews it every quarter of this.
- `KINDGI_RUN_SWEEP_INTERVAL_MS`: how often each server sweeps for runs whose lease ran out (default 60000; at least 1000, and shorter than the lease).

Out-of-range values stop the server at startup. Such a run is failed within about a lease plus one sweep.
