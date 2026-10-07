---
"@kindgi/cli": patch
---

`kindgi flows list [--name] [--limit] [--cursor]` (with `--table`), `get <flow-id> [<version>]`, `publish --spec=<json-or-@file> [--project]`, `versions <flow-id>`, `unregister <flow-id> <version>` and `reinstate <flow-id> <version>` work; before, they failed with "not yet wired". `publish` prints the flow's id and version, the pair `kindgi runs start --flow=<id> --flow-version=<v>` takes.
