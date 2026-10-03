---
"@kindgi/sdk": minor
---

Skills for Python packs: `kindgi-python-getting-started`, `kindgi-python-authoring-tools`, `kindgi-python-authoring-guardrails` and `kindgi-python-authoring-agents` (`pack_languages: [python]`), so a Python pack's coding agent learns `@tool`, `@guardrail`, `Agent` and `Flow` — schemas from pydantic models, `ToolContext` and cancellation, configuration from the environment, config defaults for checks (a pack guardrail is evaluated with `{}`), camelCase keys inside an agent's dicts, tests, wiring, flows and `kindgi.client`. A Python pack now gets these four with the shared providers, MCP-servers and framework-feedback skills; a TypeScript pack is unchanged. The TypeScript guardrails skill says the index now carries a guardrail's `config` (#17).
