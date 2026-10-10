---
"@kindgi/memory": patch
---

`MemoryBinding.searchConversations` never returns a comparison's replay conversation. An eval run's replay turn opens a conversation to re-run a past turn on another version, and its answers are no one's earlier conversation, so recall leaves them out in every scope. An implementation of the binding follows the same rule.
