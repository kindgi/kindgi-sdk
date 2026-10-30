---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**`kindgi corrections add` takes the parts of a correction as the API names them.** This is a breaking change to its flags.

- `--decisions=right|wrong` marks the run's decisions. Wrong takes `--should-call=<tool>[:<json-args>]`, a call it should have made with the arguments that matter (repeatable), and `--must-not-call=<tool>`, a tool it shouldn't have called (repeatable).
- `--answer=right|wrong` marks its answer (a flow run's whole output). Wrong takes `--should-say=<text>`, what it should have said.
- `--why=<text>` says why, and `--group=<corrector-group-id>` records it under a corrector group.
- `--item=<key> [--pointer] [--rank] (--yes | --no)` marks one item of a ranked list, as before.
- `--correction`, `--reason` and `--item=answer` (or `output`) are gone. `--item=answer` and an empty `--pointer` are a usage error that names `--answer`.
- Each call still adds to your correction of the run. A part it gives replaces what you said before about that part. A part said wrong again keeps what should have happened unless the call gives it anew, and a part said right drops it.

`kindgi corrections list` takes `--from=experts|end-users|all` and `--since=<time>` (an ISO 8601 time with a zone, or a date).

The fix-corrections skill names the new flags.
