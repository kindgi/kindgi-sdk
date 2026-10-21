---
"@kindgi/api": patch
"@kindgi/agents": patch
---

**A block registry can be read-only, as the agent, tool, flow and guardrail registries can.** `BlockRegistryBinding` gains an optional `readOnly` (`RegistryReadOnly`): while it's set, `POST /v1/blocks` and a version's `unregister` and `reinstate` are refused with `409 registry-read-only` and its reason, before the binding is called, and so is a deployment that brings blocks, before anything is written. Reads go on as before. Under `kindgi dev`, a runtime that serves the pack's blocks from its files sets it, so a publish there says to change the block's file instead.

**A turn's block miss can say where blocks come from.** `BlockReader` gains an optional `missNote`, added to the `block-unresolvable` message when no version satisfies a range. Under `kindgi dev`, a runtime that reads blocks from the pack's files uses it to say to add the block under the pack's blocks folder.
