---
"@kindgi/client": patch
---

**The TypeScript client's timeout can be set.** Until now it was fixed at 30 s, so a waited `runs.start` whose run took longer always failed on the client.
- `createClient({ …, timeoutMs })` sets how long one request may take. The default is still 30 000 ms, and streams aren't bound by it.
- `runs.start({ …, timeoutMs })` sets it for one start.
- A request the timeout ended fails with a `network` error that says so and carries `timeoutMs`.
- When it ends a waited `runs.start`, the error also says the run may still be going and that its id didn't arrive, and to start a long run with `options: { wait: false }` and follow it.
