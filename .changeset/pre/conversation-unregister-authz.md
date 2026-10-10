---
"@kindgi/api": patch
---

Unregistering a conversation (`POST /v1/conversations/{id}/unregister`) needs `write` on its project (its agent, for one from before projects): an editor or above. An unknown or already unregistered conversation answers 404.
