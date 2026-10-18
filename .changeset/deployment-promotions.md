---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**Promoting a build from one environment to the next.**
- `kindgi deploy` refused with `409 environment-takes-promotions` names where the build enters its environment order and prints each `kindgi promote` to run from there, one environment at a time, naming each environment from the pack config. When the refusal leaves out the first environment, because the caller can't read it, the hint says the rule and points at `kindgi environments list`.
- `kindgi deploy` refused with `deployment-validation-failed` prints each issue again. They're in the refusal's `details.issues`, and the CLI looked for them elsewhere.
- `@kindgi/api`: `DeploymentValue` describes one value a deployment needs where it's promoted to: a tool's secret or env, an agent's model key, or the pack's env. It says where the value is set and why it isn't ready, never the value itself. `ModelKeyLookup` says where a run finds a provider's model key.
