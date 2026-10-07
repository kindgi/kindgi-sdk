---
"@kindgi/sdk": patch
---

The Python skills run the CLI from PyPI, `kindgi-cli`, with no Node install: `uvx --from "kindgi-cli>=0.1,<0.2" kindgi init`, `uv add --dev "kindgi-cli>=0.1,<0.2"` in an existing app, then `uv run kindgi <command>`. The authoring skills (agents, tools, flows, guardrails) no longer say the CLI is on `PATH`.
