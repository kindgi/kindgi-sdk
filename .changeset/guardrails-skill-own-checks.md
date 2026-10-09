---
"@kindgi/sdk": patch
---

The guardrails authoring skills cover the built-in checks: `kindgi-authoring-guardrails` 0.3.7 shows how a pack names one (`check: 'forbidden-substring'`, no implementation), each one's `config`, that their ids are reserved for a pack's own checks (`reserved-check-id`), and that they don't check their config yet; `kindgi-python-authoring-guardrails` 0.1.4 says a `check_id` can't be a built-in's (`DefinitionError`), and that a Python pack writes the rule as its own check, since it can't name a built-in yet.
