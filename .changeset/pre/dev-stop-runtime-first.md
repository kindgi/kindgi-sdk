---
"@kindgi/cli": patch
---

**`kindgi dev` stops its runtime container about a second after Ctrl+C, without waiting on its file watchers.** On macOS, closing `kindgi dev`'s recursive file watchers holds the process for a second or more (FSEvents), and it was the stop's first step. The runtime container kept serving and holding its port and database connections until that was done. The watchers now close while `docker stop` runs. File changes seen once the stop has begun start no reload.
