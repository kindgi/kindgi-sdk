---
"@kindgi/cli": patch
---

`kindgi runs start` exits `1` when the run it waited for fails, agent or flow. It still prints the run on stdout, and stderr says why. An agent turn's failure shows its own code and message (`Error [budget-exceeded]: Agent turn cost budget exceeded (…)`, `Error [capability-routing-failed]: No registered provider satisfies the capability declaration`). Any other failure shows `Error [run-failed]: <the run's failure message>`. Since `runs start` began following runs, a failed run exited `0` with nothing on stderr, so a script couldn't tell. `--quiet` prints nothing and still exits `1`.
