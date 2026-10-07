---
"@kindgi/sdk": patch
"@kindgi/cli": patch
---

Agent instructions name tools by what they do, not by their dotted id. A model sees a tool's id in its provider's form (`my-pack__greet` for Anthropic and OpenAI-compatible models), so `my-pack.greet` in the instructions could make it call a name it wasn't given. The `kindgi init` echo agent (TypeScript and Python) now says "greet them with the greet tool … echo their message with the echo tool", and the authoring-agents skills say to name tools this way.
