---
"@kindgi/cli": patch
---

Every flag says what it does: `kindgi <command> --help` lists the command's flags with a description, the global flags in `kindgi --help` come from the same definitions, and `describeCommands()` / `describeGlobalFlags()` carry the descriptions (the docs' CLI reference shows them). The help's config precedence now names `.kindgirc.json`. The README's `--template` row matches the templates (`minimal` is the folders, no examples).
