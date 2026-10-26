---
"@kindgi/cli": patch
---

**`--allow-unattended=<tool-id>` names a tool whose calls in a webhook trigger's or a schedule's runs needn't wait for a person's yes just because no person started them.** It works on `kindgi webhooks register` and `update`, and `kindgi schedules create` and `update`.
- **Repeat it** for each tool.
- **On update,** it replaces the list, and `--allow-unattended=none` clears it. Left out, the list is kept.
- **It takes `admin`** on the project.
- **Retargeting a schedule** that lists any tools (to another `--agent` or `--flow`) must name them again, or `none`.
- **`none` is refused** on register, and with tool ids, as a usage error: nothing is sent.

`take-ownership` says which tools the trigger keeps allowed unattended, now for the new owner's runs.
