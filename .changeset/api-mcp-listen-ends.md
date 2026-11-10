---
"@kindgi/api": patch
---

**`/mcp` says its tool and resource lists never change, so a 2026-07-28 `subscriptions/listen` ends at once.** Kindgi builds a person's tools and the run view afresh for each request, and never sends a list-changed notice. The server still advertised `listChanged: true` for its tools and its resources, so a client's `subscriptions/listen` was acknowledged and then held open with keep-alives for notices that never came. It now advertises `listChanged: false` for both, in both protocol eras: a listen is acknowledged with nothing honoured and completed straight away. Listing tools, calling them and reading the run view don't change.
