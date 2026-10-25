---
"@kindgi/runtime": patch
---

**A tool that changes things with a person's connection waits for a person's yes in a run no person started, as if it declared `needsApprovalWhenUnattended`.** It counts when its `needsSpec.connections` has an entry `as: 'person'` and it isn't read-only (`mutating: false`); `needsApprovalWhenUnattended: false` doesn't lift it. So a tool that sends as someone never runs unasked under a schedule or a webhook because its author left the flag off. A trigger's `toolsAllowedUnattended` still lifts it in that trigger's own runs, as for any tool. `toolNeedsPersonsYesUnattended(tool)` answers the tool's half of the rule.
