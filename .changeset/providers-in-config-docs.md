---
"@kindgi/sdk": patch
"@kindgi/cli": patch
---

The getting-started and providers skills, and the templates' AGENTS.md, teach declaring model providers in the pack's config (`providers` in `kindgi.config.ts`, `[[tool.kindgi.providers]]` in `pyproject.toml`), which `kindgi dev` registers on every boot. The providers skill's Gemini example has the models' real output limit, 65,536 tokens.
