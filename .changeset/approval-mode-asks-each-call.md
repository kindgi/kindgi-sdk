---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/policy-contract": patch
"@kindgi/sdk": patch
"@kindgi/specs": patch
"@kindgi/tools": patch
---

**The docs say what `ask_on_first_use` does: each call to the tool waits for an approval, as with `always_ask`.** They said an approved call ran without asking when it was made again with the same arguments in the conversation, but nothing remembers an approval, and every call has always asked. The mode's doc is now on `ToolHitlMode`, where an editor shows it, and `Tool.mutating`'s description (in the tool schema and the API reference), the approvals guide and the authoring skills say the same. How a call is gated doesn't change.
