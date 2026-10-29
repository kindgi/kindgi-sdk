---
"@kindgi/cli": patch
---

**`kindgi schedules`, `kindgi webhooks` and `kindgi mail-triggers` show a trigger's versions.**
- `versions <id> [--limit=<n>] [--cursor=<c>]` pages a trigger's versions, newest first. Under `--table` it shows each one's number, when it was made, by whom (`Kindgi` for a version the runtime made itself, which names no one) and why.
- `get <id> <version>` reads one version, as `kindgi flows get` and `kindgi agents get` do. The version is a whole number from 1, and anything else is refused before any call. Without one, `get` is the trigger as it is now. `kindgi schedules get` takes `--upcoming` only without a version, and `kindgi webhooks get` with a version prints no receive URL.
- `list --table` has a `VERSION` column, the trigger's newest version. It's empty for a trigger from before versions, until its next change or its first fire.
