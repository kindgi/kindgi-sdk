---
"@kindgi/api": patch
"@kindgi/policy-contract": patch
---

A page cursor a list didn't issue answers `400 bad-input` on the agents, flows, policies and eval-suites `/versions` lists and on an agent's promotions, instead of the first page again.
- **The bindings say so:** the agent, flow, policy and eval-suite registries gain an optional `issuedCursor(list: 'versions', cursor)`, and the promotions binding an optional `issuedCursor(list: 'promotions', cursor)`. The route asks before it reads the list, and answers `400 bad-input` ("`cursor` is malformed") when the binding says no. A binding without the method gets any cursor, as before.
- **Why:** a binding that reads a cursor it didn't issue as no cursor hands back the first page, so a client paging until done would start over. The cursor stays opaque to the API: only the binding that issued it knows its shape.
- **The OpenAPI document** now lists the `400` on these operations, and on the blocks and tools `/versions` lists, which already answered it.
