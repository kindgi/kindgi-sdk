---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/client": patch
---

Improvement passes can draft prompt templates. `POST /v1/proposals/improve` takes `tiers: ['prompt']` with `model` (the tenant's provider and model that drafts the templates) and `candidates` (1–5, default 3). The agent version must take its instructions from a prompt block it pins.
- Every pass takes `classWeights`, default `restricted-only`: a pass learns from trusted judgments only.
- `checkDraftedTemplate` (`@kindgi/agents`) checks a drafted template against what the agent has. It must parse as Liquid and may read only the declared parameters, the current template's variables, the turn's clock and identity, and the settings blocks the version pins. It may not name a dotted id the agent doesn't use, and it may be at most twice as long as the current template (at least 2,000 characters).
- Comparisons take `overrides.prompts`: a template for a prompt block the version pins, checked at start. The summary's candidate names the overridden prompt blocks, and a promotion gate fails such a comparison (`sameContents`).
- The replay binding's `settings` is now `overrides` (`settings` and `prompts`).
- A judged test set's reasons name their judgment's class (`judgeClassId`) and say whether it was recorded while the class was restricted (`restricted: true`).
