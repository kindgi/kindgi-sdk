---
"@kindgi/cli": patch
---

**Exit code 3 when a command ran and its answer is no, and `--wait` for an approval.** A CI step can now fail on a release gate policy's answer, and wait for a reviewer.

- **Exit code 3** means the command ran and the answer is no. The output is unchanged, `--json` too. An error is still 1, and a usage error 2.
  - `kindgi agents promote --check` exits 3 when the answer is `gate-failed` or `needs-approval`, and 0 when it's `would-promote`.
  - `kindgi agents promote` exits 3 when the gate refuses the version (`422 gate-failed`, said as before; it was 1), and when the promotion waits for an approval (`202 pending-approval`; it was 0).
  - `kindgi promote --make-live` exits 3 when a version it carries doesn't go live: held by the gate, or waiting for an approval. It was 0.
  - `kindgi eval-runs start --wait` and `kindgi eval-runs rescore --wait` exit 3 when the run failed or was cancelled. It was 0.
  - `kindgi promote` still exits 1 while a value the build needs isn't set in the target: then it can't promote at all.
- **`--wait[=<duration>]`** on `kindgi agents promote` and `kindgi promote --make-live` waits for a version that waits for an approval, until a reviewer decides.
  - The duration is like `90s`, `30m` or `2h`. A bare `--wait` waits up to an hour.
  - It reads the promotion every 5 seconds, and says first which approval it waits for and the command that approves it.
  - It exits 0 once the version is live, and 3 when the approval is rejected or expires, the promotion is superseded, or the wait runs out. The output is the promotion as it ended.
  - `kindgi promote --make-live --wait` waits for every carried version that waits for an approval, within one deadline. It doesn't wait when a version is held by a failed check, since then not every version can go live.
  - The wait never withdraws the approval: once it's approved, the version goes live. Ctrl-C stops the wait with exit 130.
  - `--wait` with `--check`, or `kindgi promote --wait` without `--make-live`, is a usage error.
