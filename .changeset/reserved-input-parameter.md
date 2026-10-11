---
"@kindgi/agents": patch
---

A parameter named `input` is refused when an agent or a prompt block is defined, as `today`, `now`, `agent`, `conversation` and `settings` already were: `"input" is a reserved auto-injected variable — do not declare it as a parameter`. Before, it was accepted, and the turn's structured input silently replaced its value whenever a turn carried one. The reserved names now come from `AUTO_INJECTED_VARS` itself, so a new auto-injected variable is reserved as soon as it's added.
