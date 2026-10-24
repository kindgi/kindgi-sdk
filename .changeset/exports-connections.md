---
"@kindgi/cli": patch
---

**`kindgi exports create` exports connections:** the tenant's app registrations (`connection-apps.jsonl`) and its connections (`connections.jsonl`), removed ones included, each as its route answers it. Neither holds a token, and a registration names its secrets by reference only. The apps a server can connect to and connect requests aren't exported.
