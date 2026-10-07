---
"@kindgi/cli": patch
---

**Closing the terminal stops `kindgi dev` cleanly, its runtime container included.** Before, closing the terminal (SIGHUP) ended `kindgi dev` at once. With no Ctrl+C first, its runtime container kept running, holding its port and database connections. Right after a Ctrl+C, the stop was cut short and the container was left behind. A hangup now starts the same stop as Ctrl+C, and it never forces the exit. Output to the closed terminal is dropped instead of ending the process mid-stop.
