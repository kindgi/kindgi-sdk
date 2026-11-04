---
"@kindgi/cli": minor
"@kindgi/types": patch
"@kindgi/sdk": patch
---

**`kindgi dev` and `kindgi build` warn about an agent or flow id that isn't the pack's id, a dot and a name.** An agent's or a flow's id is `<pack-id>.<name>`: the pack's own id (`pack.id` in its config), a dot, and a lowercase kebab-case name with no dot. Until now nothing checked that shape, since defining an agent or a flow checks only that its id isn't empty. Both commands now print a warning, with its file, for each id of another shape, for packs in every language:

```text
⚠ flows/record.py: flow "acme.ledger.record-flow" isn't named "acme.<name>" (this pack's id, a dot, then a lowercase kebab-case name with no dot). An id is hard to change once something calls it, so rename it while it's new. The pack runs as it is.
```

The pack builds and runs as it did. A pack id may hold dots of its own, so `acme.legal.review-contract` is right in the pack `acme.legal`.

**The id types and the skills say what is checked.** The `AgentId`, `FlowId`, `ToolId` and `GuardrailId` comments, and the agents and tools skills, said the define calls enforced the id's shape. They check only that the id isn't empty, and for a tool that it doesn't start with `kindgi_`.
