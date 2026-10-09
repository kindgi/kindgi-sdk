---
"@kindgi/handler-runtime": patch
---

A pack can't ship its own guardrail check under a built-in check's id (`must-cite`, `never-call-tool`, `max-tool-calls`, `output-matches`, `tool-order`, `required-substring`, `forbidden-substring`): the runtime runs the built-in for a guardrail naming one, so a pack's implementation under that id would be silently replaced. Building or running the pack refuses it with `reserved-check-id`, saying to rename the check. That covers a TypeScript guardrail whose `check` (or any check its module exports) has a built-in id and an `evaluate`, and a Python `@guardrail` whose check id (`check_id=`, or the guardrail's own id) is one. Naming a built-in (`check: 'must-cite'`) without shipping an implementation is how to use it, and keeps working. `RESERVED_CHECK_IDS` is exported from `@kindgi/handler-runtime` (Python: `kindgi.pack.define.RESERVED_CHECK_IDS`).
