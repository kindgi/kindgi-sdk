---
"@kindgi/cli": patch
---

`kindgi init`'s next steps and `kindgi dev`'s banner now agree about an agent with no model registered. Under `kindgi dev`, its dev-echo fallback answers with canned replies until you register one. A runtime without that fallback (a `--runtime-url` you started yourself) fails the turn, and the banner says why.
