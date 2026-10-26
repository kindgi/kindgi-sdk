---
"@kindgi/cli": patch
---

**`kindgi mail-triggers`: start runs from new mail in a Gmail or Outlook mailbox.** It has `list`, `get`, `create`, `update`, `pause`, `resume`, `fires`, `take-ownership` and `unregister`.
- `create` takes what to run, with `--agent=<id> [--agent-version=<v>]` or `--flow=<id> --flow-version=<v>`, as the other trigger commands do. `--mailbox=google|microsoft` is required.
- `--as=person` (the default) watches your own mailbox, through your connection. `--as=company` watches the company's, through the company's connection, and takes `admin` on the project. `--run-as=<service-account-id>` goes with `--as=company` only, and is refused before the call otherwise.
- `--folder`, `--poll`, `--runs-per-hour`, `--label` and `--project` set the rest, and `--allow-unattended` names the tools whose calls in its runs needn't wait for a person's yes.
- `update` changes only what it's given. `--mailbox` and `--as` go together there, since the mailbox is replaced whole, and `--allow-unattended=none` clears the list.
- `take-ownership` names the tools the trigger keeps allowed unattended, with the line that clears them.
- `fires` lists a trigger's mail: the run each started, why a mail waits (`thread-busy:`, behind an earlier mail of its thread), or why it was skipped, refused or failed. `--table` shows it as a table, as `list --table` does for the triggers.
