---
"@kindgi/guardrails": patch
"@kindgi/api": patch
---

The built-in guardrail checks check their config. A guardrail naming one (`must-cite`, `never-call-tool`, `max-tool-calls`, `output-matches`, `tool-order`, `required-substring`, `forbidden-substring`) with a config the check doesn't take is refused when it's registered (`POST /v1/guardrails`: `422 guardrail-config-invalid`, each problem in `details.issues`) or deployed (`deployment-validation-failed`), and if one still reaches a turn it's a check that can't run (`invalid-check-config`), so a `halt` guardrail fails closed. Before, a mistake could silently disable the rule: `never-call-tool` with `tools: "acme.refund"` (not a list) forbade nothing. Each built-in publishes its config as JSON Schema (`configSchema` on its registered check), refuses a setting it doesn't know, and checks that a regular expression compiles. A deployment's index guardrail carrying a field this version doesn't know (from a newer CLI) now deploys, the field dropped, instead of failing the deployment; `POST /v1/guardrails` stays strict. `GUARDRAIL_SPEC_KEYS` is exported from `@kindgi/guardrails`.
