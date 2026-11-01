---
"@kindgi/cli": patch
---

**`kindgi dev`'s Linux sandbox runs its helper programs by their full path.** On Linux, `kindgi dev` starts the pack service and the indexer in bubblewrap through a small `sh` script. That `sh`, and the `bwrap`, `mktemp`, `sed` and `rm` the script runs, are now the ones in `PATH`'s absolute entries, never ones in the folder it runs in. When one of them isn't on `PATH`, the start fails with `spawn <name> ENOENT`. The check that bubblewrap works, which `kindgi dev` makes when it starts and `kindgi doctor` makes too, finds `bwrap` the same way. With none there, it says bubblewrap isn't installed, as before.
