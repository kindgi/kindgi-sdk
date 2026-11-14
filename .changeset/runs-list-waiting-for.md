---
"@kindgi/api": patch
"@kindgi/client": patch
---

**The runs list can say what each waiting run waits for: `include=waitingFor`.**

- `GET /v1/runs?include=waitingFor` gives each suspended run on the page the `waitingFor` that `GET /v1/runs/{runId}` gives it: the approvals still to be decided, the connects and the waits for another system's answer it waits for, and the rest. Other runs carry nothing more. It goes with `output`: `include=output,waitingFor`.
- A suspended run's waits are read from its journal and more, so with `waitingFor` a page holds at most 25 runs (a larger `limit` gives 25), and the list reads them five at a time.
- The TypeScript client's `runs.list` takes `includeWaitingFor`, beside `includeOutput`. The Python client's `runs.list` takes `include="waitingFor"`. An older runtime refuses the value with `400 bad-input`.
