---
"@kindgi/api": patch
---

**A trigger's `toolsAllowedUnattended` can list the tools built into Kindgi that its target is offered.** Until now only the tools an agent lists in `tools` counted, so a list naming a built-in was refused as one the target doesn't call.
- `kindgi_remember`, on any trigger, for an agent that declares `memory.remember`, a flow's agent step included.
- `kindgi_reply_to_text` and `kindgi_hand_to_person`, on a text trigger only, for its agent target or its flow target's own agent steps. A flow with no agent step of its own, or with agent steps only in its subflows, doesn't call them.
