---
"@kindgi/cli": patch
---

`kindgi provenance list [--run] [--agent] [--created-after] [--project | --org] [--limit] [--cursor]` (with `--table`), `get <run-id>` and `export <run-id> --signing-key=<key-id> [--include-messages]` work; before, they failed with "not yet wired". A deployment without a signing key answers `export` with that refusal.
