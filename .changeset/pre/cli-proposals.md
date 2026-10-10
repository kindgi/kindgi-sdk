---
"@kindgi/cli": patch
---

`kindgi proposals` works with improvement proposals (before, it wasn't implemented):
- **`draft`:** new content for one data block an agent version pins, for one scope.
  - `--values=<json>|@<file>` for a settings block, or `--template=<text>|@<file>` for a prompt block.
  - It takes `--hypothesis` and repeatable `--judgment` evidence.
- **`evaluate <id> --test-set=<suite-id>`:** a comparison of the candidate.
  - Options: `--objective`, `--reads`, `--repetitions`, `--k` and `--class-weights`.
  - `--wait` waits until it's `evaluated`, `not-better` or `evaluation-failed`.
- **`request <id>`:** its promotion through the scope's gate.
- **`rollback <id>`** and **`withdraw <id> --reason`**.
- **`list`** (`--agent`; a scope, `--tenant`, `--org` or `--project` with `--segment`s, for exactly that scope; `--tier`; `--status`; `--table` shows the scope, block, status and the evaluation's delta) and **`get`**.
