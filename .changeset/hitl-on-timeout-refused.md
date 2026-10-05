---
"@kindgi/agents": patch
---

An agent's `conversationPolicy.hitl.onTimeout` is refused unless it's `'escalate'`. `'auto-approve'` and `'auto-reject'` were accepted and ignored: an approval that times out escalates one reviewer tier, and at `admin` it expires (the turn fails with `hitl-cancelled`), whatever the setting said. `defineAgent` (and an agent registered through the API) now refuses them, saying what happens instead: `hitl.onTimeout 'auto-approve' isn't supported: an approval that times out escalates one reviewer tier, and at admin it expires (the turn fails with hitl-cancelled). Use 'escalate', or leave it out.` The type allows `onTimeout?: 'escalate'`.
