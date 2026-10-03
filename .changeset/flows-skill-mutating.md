---
"@kindgi/sdk": patch
---

The `kindgi-authoring-tools` skill says what `mutating` does: `mutating: false` declares a tool read-only, so it runs in a dry run and approval gates don't ask before it by default; leaving it out counts as mutating. The `kindgi-authoring-flows` skill had this backwards in its common mistakes; it now lists both real mistakes (`mutating: false` on a tool that writes, a read-only tool without it), and its example flow drops the id casts `defineFlow` no longer needs.
