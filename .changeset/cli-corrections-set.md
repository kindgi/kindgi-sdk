---
"@kindgi/cli": patch
---

**`kindgi corrections set <correction-id>`** re-sorts a correction (`--sorted-to=improve|developer|owner`), changes its status (`--status=open|being-fixed|wont-fix`), or both, through `PATCH /v1/corrections/{correctionId}`. `--link` names what fixes it, for `being-fixed`, and `--reason` says why: `wont-fix` needs one. It takes `--status`, `--sorted-to` or both.

`kindgi corrections list` takes `--status` (with `not-fixed` for `open`, `being-fixed` and `with-owner`) and `--sorted-to` (with `none` for the unsorted). Each can be repeated or comma-separated. Removed corrections are listed only when `--status` names `removed`.
