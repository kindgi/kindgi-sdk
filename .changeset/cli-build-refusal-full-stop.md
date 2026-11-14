---
"@kindgi/cli": patch
---

When a build service refuses `kindgi build`, the printed line now ends the service's message with a full stop if it has none, so the "Try again in N s." after it reads as a sentence of its own. A refusal with an empty message ends the line at its code.
