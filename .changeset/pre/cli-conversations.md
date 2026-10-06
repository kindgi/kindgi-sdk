---
"@kindgi/cli": patch
---

`kindgi conversations get <conversation-id>`, `open <agent-id> <version> [--title] [--project] [--participant]`, `close <conversation-id>` and `messages <conversation-id> [--limit] [--cursor]` work, and are in `--help` and the reference. Before, they failed with "not yet wired". A turn joins a conversation through its input: `kindgi runs start --agent=<agent-id> --input='{"userMessage": "…", "conversationId": "<conversation-id>"}'`.
