---
"@kindgi/cli": patch
---

**`kindgi deploy --quiet` prints errors only, as `kindgi dev` does.** Until now it printed every one of deploy's own lines under `--quiet`.
- **A refused deployment** still prints the server's refusal, and a deploy that stops before it is sent still prints its error.
- **A secret sync that fails** prints its error under `--quiet` too. The exit code stays 0: the deployment is in place. A sync that never reaches the server now also says that the deployment landed and how to sync again.
- **A pack service env that refuses the deploy** prints its plan, then the error that points to it.
- **The global `--quiet`** now reads "Print errors only: the exit code reports the result."
