---
"@kindgi/cli": patch
---

`kindgi memory facts list [--type] [--scope=<json>] [--limit] [--cursor]` (with `--table`), `get <fact-id>` and `write --input=<json-or-@file>` work; before, they failed with "not yet wired". `write` fills in the scope's `tenantId` with yours when the input leaves it out. `supersede` and `retrieve` say why they aren't available. A nested group's `--help` names its whole path (`Usage: kindgi memory facts <subcommand>`).
