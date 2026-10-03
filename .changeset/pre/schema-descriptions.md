---
"@kindgi/specs": patch
"@kindgi/flow": patch
"@kindgi/guardrails": patch
"@kindgi/tools": patch
"@kindgi/capabilities": patch
"@kindgi/memory": patch
"@kindgi/sdk": patch
---

JSON Schema descriptions (51, across 12 schemas and their bundled copies) now match the code and stay inside this repository: neutral examples (`acme.*`), no vendor names the code doesn't target, "the Kindgi runtime" instead of "the OS", no roadmap notes, and corrected claims (tool `needs` are declarative, `capability-unsatisfiable` happens at routing time, `step.cancelled` wording, SSE `eventId`). `Capability.budget` and `Guardrail.budget` are documented as declarative — not enforced by the runtime — in the schemas and the TypeScript types. Only `description` values changed; keys, types, enums and `$comment` schema versions are unchanged.
