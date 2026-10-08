---
"@kindgi/sdk": patch
---

The `kindgi-authoring-providers` skill (0.9.9) says a provider spec its adapter can't use is refused when it's registered (`422 provider-config-invalid`, one `✗ <path>: <message>` line per problem), and that `kindgi doctor` names the problems of a registration stored before 0.1.5.
