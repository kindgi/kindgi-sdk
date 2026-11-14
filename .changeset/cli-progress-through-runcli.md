---
"@kindgi/cli": patch
---

`kindgi connections connect`'s link and waiting line, and `kindgi exports create`'s line for each kind, go out through `runCli`'s `progress`, as `kindgi build`'s and `kindgi deploy`'s lines do, after the dev runtime's line and the pin warning that the CLI says first. A tool that embeds the CLI gets them there, no longer straight on its process's stderr. Given no `progress`, `exports create` returns its lines in the outcome's `stderr`, and `connections connect` at a terminal still writes its link to stderr, since the person needs it while the command waits. `connectionsSeam.progress` and `exportsSeam.progress` are gone: pass `progress` to `runCli` instead.
