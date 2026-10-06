---
"@kindgi/agents": patch
"@kindgi/api": patch
---

**Data blocks: a settings schema holds for every later version, and a repeated derive returns the version that has it.**

- **A settings version that gives no `schema` keeps the latest version's.** The runtime stores it on the new version, so it's checked on every later version, not just the next one. A version that gives a schema replaces it, and is checked against that schema only. `{}` drops the check on purpose. Before, one edit that didn't restate the schema dropped it for good.
- **`POST /v1/agents/{agentId}/versions` with a swap an active version already holds** returns that version unchanged (`200`), instead of numbering a duplicate. That covers the same swap derived again, or a deploy that registered it.
- **Errors:**
  - Publishing an agent that can't be pinned says "uses tool or data-block versions it can't pin" (it said "tool versions", even for a block issue).
  - A template's unresolved settings block is named in full: `settings.acme.reply-style`, not `settings.acme.reply`.
