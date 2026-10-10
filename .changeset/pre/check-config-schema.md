---
"@kindgi/handler-runtime": patch
"@kindgi/pack-conformance": patch
---

**The TypeScript pack service checks a check's `config` against the guardrail's indexed `configSchema` before it runs the check, as the Python pack service does.**
- **A config that doesn't fit** answers `input-validation-failed`, with `checkId` and the issues, and the check doesn't run.
  - **Before:** a check defined with `defineCheck` refused it as `handler-throw`.
  - **Before:** a check whose `configSchema` was only on the guardrail ran with it.
- **The message names the first issue** in both pack services: `Check "<id>" config failed validation at /maxChars: must be > 0`. A runtime reports a check's error by its code and message alone.
- **The config is checked as sent.** The schema's defaults aren't filled in, as when the indexer checks a declared config; the check's own schema fills them in.
- **A `configSchema` that doesn't compile** answers `input-validation-failed` in both pack services, as a tool's input schema does. The Python pack service used to skip the check.
- **`CheckInvocationSpec.configSchema`** is new and optional, for `runCheck`.
- **pack-conformance** has a case for it, so the two services can't diverge again.
