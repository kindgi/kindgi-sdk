---
"@kindgi/cli": patch
---

**`kindgi license enroll`, `kindgi license renew` and `kindgi init` in an existing app follow `--json`, `--raw`, `--table` and `--quiet`.** Before, both license commands printed their lines on stdout whatever the flags, and `init` in an existing app always printed its summary as pretty JSON, with every note.
- `kindgi license enroll --json` prints `renewerId`, `renewer`, `changed`, `overwritten`, `login`, `accessUrl`, `enrollLine` and `nextSteps` on stdout, and its lines on stderr. Under `--quiet`, it prints the enroll line alone on stdout: it's what you add at access.kindgi.com.
- `kindgi license renew --json` prints `status`, `renewerId`, `license` (`name`, `use`, `expiresAt`, `daysLeft`), `counts` (with `--runtime`) and `warnings` on stdout, and its lines on stderr. `daysLeft` is negative once the key has expired. Under `--quiet`, it prints only its warnings, on stderr: the `⚠ It expires in <N> days` line, and a `counts: not sent (…)` line other than a production key's.
- `kindgi init` in an existing app, in every language, prints its summary on one line with `--raw`. Under `--quiet`, it prints no summary and keeps only its ⚠ warnings on stderr, as `init` for a new pack does.
- With `--json` or `--raw` too, `--quiet` wins, as for every command.

With none of these flags, all three print exactly what they printed before, so the Azure module's alerts on `renew`'s lines are unchanged.
