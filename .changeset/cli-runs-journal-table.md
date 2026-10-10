---
"@kindgi/cli": patch
---

`kindgi runs journal <run-id> --table` prints the journal as a table: each entry's sequence, kind, node and time. It used to accept `--table` and print JSON anyway. JSON stays the default, with each entry's payload.
