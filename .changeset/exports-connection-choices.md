---
"@kindgi/cli": patch
---

**`kindgi exports create` exports connection choices:** each project's choices, removed ones included (`connection-choices.jsonl`), each line with the project it was read for. The connections a choice may name aren't exported, since a server works them out from the connections.
