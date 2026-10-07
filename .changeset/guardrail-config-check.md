---
"@kindgi/specs": patch
"@kindgi/guardrails": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**A guardrail whose config its pack check would refuse can be refused at registration.**
- **The gap:** `POST /v1/guardrails` naming a pack's check with a config that breaks the check's `configSchema` was accepted. Then the pack service refused every call, so every turn the guardrail checked failed.
- **`createApp({ checkGuardrailConfig })`:** a runtime passes this optional hook, and the route answers **`422 guardrail-config-invalid`**:
  - the message is one sentence naming the guardrail, the check and the first problem: `Guardrail "acme.strict" doesn't fit check "my-pack.checks.answer-length": config.maxChars must be > 0.`;
  - `details.issues` lists every problem, `{ path, message }`, with `path` a JSON pointer into the guardrail (`/config/maxChars`) and `message` naming the setting (`config.maxChars must be > 0.`), the provider check's shape.
  - Without the hook, nothing changes.
- **`Guardrail.configSchema`** is a new optional runtime-declaration field, like `codeArtifactRef`. `POST /v1/deployments` now keeps the pack index's `configSchema` on each guardrail it registers, so a runtime can check against it.
- **`@kindgi/guardrails`:**
  - `guardrailConfigProblems({ configSchema, config })` checks the config as declared, without filling in defaults, as the indexer and the pack service do;
  - `describeGuardrailConfigProblems` words the message.
- **Both clients** read `guardrail-config-invalid` as an invalid request, with its `issues`. The CLI prints the message and one line per issue.
