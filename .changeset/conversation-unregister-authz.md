---
"@kindgi/api": patch
---

Unregistering a conversation (`POST /v1/conversations/{id}/unregister`) needs `write` on its project (its agent, for one from before projects), an editor or above. Before, any signed-in principal in the tenant could unregister any conversation when authorization was on.
