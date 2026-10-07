---
"@kindgi/cli": patch
---

`kindgi dev`'s banner names every LLM provider when only dev-echo can answer: "for a real model: set an LLM provider key, then `kindgi providers register --preset=<anthropic|gemini-api|groq|openai|openrouter>`". It named Anthropic only, while dev-echo's answer, its warning and `kindgi doctor` offer them all. The list comes from the presets the CLI ships.
