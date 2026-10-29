---
"@kindgi/api": patch
"@kindgi/runtime": patch
---

**A resume after a wait's answer that finds the run still held logs at `info`, not as a warning.** When another system answers a wait (the wait token's link, or `POST /v1/runs/{runId}/resume` with a pause), the API resumes the run behind the answer. If the executor that parked the run still holds it, the resume can't take it, and the run goes on there: a normal timing, which was logged as `resume after a wait token answer failed`. Every other failure stays a warning, a lease the resume took and then lost among them.
- `RunLeaseLostError` (`@kindgi/runtime`) has an optional `held: true`, for a resume that never took the run. It's in-process only: the run handler passes it in its failure's `details`, the API logs by it, and no HTTP answer carries it (an approval's `resume` leaves it out). Without it, the log is as before.
