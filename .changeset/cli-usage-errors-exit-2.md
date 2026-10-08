---
"@kindgi/cli": patch
---

**A usage error exits 2 everywhere.** Exit 2 now covers a missing argument, a missing or conflicting flag, and a value a flag can't take, the same as an unknown command, subcommand or flag. Exit 1 is left for a call that failed. Scripts can tell "called it wrong" (2) from "the call failed" (1).
- **What it prints:** `Error: <what's wrong>` and `Usage: kindgi <command> --help` on stderr.
- **Moving from exit 1 to 2:**
  - **Any command:** a missing required argument (`kindgi runs get` with no run id); a value that isn't an integer for an integer flag (`--limit=abc`); a malformed `key:value` flag (`--segment`); malformed JSON for a `--spec`, `--input` or `--manifest`.
  - **`agents`:** `publish` without `--spec`; `derive` without `--from`, with no swap, or a malformed swap; a scope given twice or `--segment` without `--project`.
  - **`approvals complete`** without a known `--decision`; **`approvals list`** with an unknown status.
  - **`auth login`** without `--url` or `--token`.
  - **`blocks`:** no `--block-version`, an unknown `--kind`, no `--project`, or both `--prompt` and `--settings`.
  - **`conversations list`:** an unknown filter value.
  - **`env set` / `env unset`:** a missing `<KEY>` or `<VALUE>`.
  - **`eval-runs start`:** no `--project`, both or neither of `--agent`/`--flow`, a malformed `--baseline`, `--with`, `--reads` or segment, a baseline flag without `--baseline=live`. **`eval-runs list`:** an unknown status.
  - **`eval-suites`:** no `--suite-version` or `--project`, an unknown `--kind`, both or neither of `--agent`/`--flow`, `--min-judgments` under 1.
  - **`feedback`:** a missing or unknown `--kind`, no `--title`, an unknown `--severity` or `--authored-by`.
  - **`flows register`, `guardrails register`, `tools register`, `reviewers register`, `memory`:** a missing `--spec`, `--manifest` or `--input`, or one of the wrong shape.
  - **`gate-policies`:** a missing required flag.
  - **`init`:** an unknown `--template`.
  - **`judge-classes`:** a scope that conflicts or is missing; an unknown role or principal kind; a weight under 0; no `--name` or `--weight`; `--unrestricted` with restriction flags; `set` with nothing to change.
  - **`judgments`:** no `--run` or `--item`, both or neither of `--yes`/`--no`, a negative `--rank`, `--agent-version` without `--agent`, an unknown `--verdict`.
  - **`key create` / `export` / `revoke`:** a missing or invalid key id; **`key export`:** an unknown `--format`.
  - **`provenance`:** both `--project` and `--org`, no `--signing-key`.
  - **`providers register`:** neither `--spec` nor `--preset`, an unknown preset, an unknown model in `--models`, a preset's missing setting flag, a bad `--max-output-tokens`. **`providers list`:** a bad `--limit`.
  - **`runs start`:** neither or both of `--agent`/`--flow`, a version flag without its id, no `--input`. **`runs list`:** a bad `--limit` or `--replays`.
- **Unchanged:** a call that failed still exits 1. That includes the API refusing it, a failed run or check, a missing pack secret, and a file that already exists (`key create`).
