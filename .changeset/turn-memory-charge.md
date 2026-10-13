---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/env-schema": patch
---

**An agent turn's memory, charged by size, for a runtime that limits it.**
- **`InvokeAgentBindings.turnMemory`,** optional: `charge(bytes)` answers `{ ok: true }`, or `{ ok: false, limit: 'tenant' | 'server', heldBytes, limitBytes }`. A runtime binds one per turn (one `invokeAgent` call), so two turns of one run are charged apart, and releases the turn's charge when it settles. Without it, nothing is charged.
- **The charge** is taken before each model call: (4 + the iterations done) × the conversation as sent, in UTF-8 bytes, replacing the turn's last charge. The first is taken once the first messages are built. Each later one comes after the last tool results have joined the conversation and been journaled. A dry run is never charged.
- **Refused,** the turn fails with `turn-memory-limit-reached` before the model is called, naming the limit, what it holds and its size. Every tool call the turn finished is already in the conversation, so a new turn there doesn't call it again.
- **The API's error map** gains `429 turn-memory-limit-reached`, with no `Retry-After`. The clients read it as rate-limited, with the code in `serverCode`.
- **Two runtime settings,** off unless set: `KINDGI_TURN_MEMORY_MIB` (every tenant's turns together) and `KINDGI_TURN_MEMORY_PER_TENANT_MIB` (one tenant's). Used from runtime 0.1.8.
