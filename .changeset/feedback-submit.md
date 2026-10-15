---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**`kindgi feedback submit` sends `FEEDBACK.md`'s entries to Kindgi, exactly as the person saw them; `status` and `withdraw` follow them up.**
- **`submit`** sends to Kindgi's private intake on access.kindgi.com: the entries named, or every one not sent yet and not fixed.
  - `--preview` prints the exact request, after redaction, with its digest, and sends nothing. `--yes=<digest>` sends it only if nothing changed since. At a terminal it asks instead; with no terminal and no `--yes`, nothing is sent.
  - Redaction runs first: the home directory, paths outside the pack, values from the pack's env files, private keys, token shapes, URL user info and query values, and email addresses. The environment goes as the OS, Node and CLI versions, the pack's language, and `kindgi doctor`'s checks as id and status only.
  - Each entry gets a `submitted` line with its report id, which isn't a secret. The key that withdraws a report is kept in `~/.kindgi/feedback/keys.json` (0600) on the machine that sent it, and is never printed.
  - When the answer is lost, comes too late or can't be read, it says Kindgi may have received the reports, and that sending again makes a second report. Once they're received, a key that can't be kept or an entry that can't be marked is said beside that, and the entries are still marked.
  - `KINDGI_FEEDBACK_SUBMIT=off` turns sending off; any value but `on` or `off` does too, and says so.
- **`status`** says what became of each report: received, known (with its issue), fixed (with the version), won't fix (with why), or withdrawn. It asks at most once a day unless the report is named, never again once it's final or, unless it's named, once the intake doesn't have it, and marks a fixed entry in `FEEDBACK.md`.
- **`withdraw <id|hash|reportId>`** takes reports back: the intake clears their text at once.
- **The `kindgi-framework-feedback` skill** (0.4.4) and the templates' `AGENTS.md` tell a coding agent to send only after the person says yes to the preview, and to run `status` at the start of a session.
