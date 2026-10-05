---
"@kindgi/cli": patch
---

**When the runtime container stops while `kindgi dev` starts it, the message always says why.**
- It names the container's exit code and what the code means: 137 killed or out of memory, 139 a crash, 126/127 a command that couldn't run. Docker's own error is included when there is one.
- It gives the container's last log lines, read whole.
- A container that stopped before printing anything is said to have done so. Before, the message could end with an empty reason.

The container no longer runs with `--rm`, so a fast exit's logs and exit state can still be read; `kindgi dev` removes it itself, when it stops and after a failed start. `docker logs`' own errors (such as "can not get logs from container which is dead…") are no longer shown as the runtime's output.
