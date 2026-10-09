---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
"@kindgi/client": patch
---

`kindgi dev` reads the runtime's and the pack service's log records and shows them pretty, each line tagged `[runtime]` or `[pack]`, coloured on a terminal unless `NO_COLOR` is set. The runtime container writes JSON for it.

New flags:
- `--log-level=<level>` (default `KINDGI_LOG_LEVEL`, from the shell then the env files, else `info`) and `--log=<subsystem>=<level>` (repeatable) set what's shown. The runtime, the pack service and the indexer get them as `KINDGI_LOG_LEVEL`/`KINDGI_LOG_LEVELS`, so they write only that.
- `--log-format=json` writes each record as written, one per line on stdout, for `| jq`; everything else stays on stderr.
- `--quiet` now quiets `kindgi dev`'s live output too: errors only.

What pack code prints while it's indexed is shown at `debug` (subsystem `pack.index`) instead of being dropped. A runtime you run with `--runtime-url` gets the levels in `runtime.env`, and its own terminal picks the format.

The pack-service supervisor's `log` event carries the line as written (`line`). Both pack services, TypeScript and Python, no longer warn about a `KINDGI_LOG_LEVELS` entry for a subsystem they don't know: pack code logs under its own names too.
