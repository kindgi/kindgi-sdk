---
"@kindgi/sdk": minor
---

Every bundled skill declares the pack languages it is written for (`pack_languages` in its frontmatter), so `kindgi init` and `kindgi skills sync` copy a Python pack only the skills that apply to it. The providers, MCP-servers and framework-feedback skills cover Python packs (`[tool.kindgi]` in `pyproject.toml`, the `kindgi` on `PATH`, `preferred_provider=`); the getting-started and authoring skills stay TypeScript. The providers skill lists the current Claude models and prices, and says to run `kindgi dev --no-dev-echo` once a real provider is registered — dev-echo otherwise keeps answering for any provider id that sorts after it.
