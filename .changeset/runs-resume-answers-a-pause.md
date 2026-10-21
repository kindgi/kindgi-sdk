---
"@kindgi/cli": patch
---

**`kindgi runs resume` answers a run's wait for another system, and says when a run waits for one.**

- **`kindgi runs resume <run-id>`** names each wait for another system's answer (a tool's call that paused): what it waits for, the tool and step, when it times out, and the command that answers it. It exits `5`, the code that was reserved. An approval still comes first (exit `3`), and the run's waits for answers are listed after it.
- **`--output=<json-or-@file>`** answers the wait, as the other system would through the link its tool handed on: the value is the paused tool's output, checked against its output schema. The command then says what the run waits for next, with that answer's exit code. It answers the run's one wait; when the run waits on more than one, `--waitpoint=<id>` names it (the `pause:` id `kindgi runs get` lists under `waitingFor.tokens`). With none, it sends nothing and exits `1`.
- **`kindgi runs get`** prints a line per wait for another system's answer after the run's JSON, on stderr, with the command that answers it.
