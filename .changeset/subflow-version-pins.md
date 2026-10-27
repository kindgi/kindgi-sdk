---
"@kindgi/flow": patch
"@kindgi/specs": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/cli": patch
---

**A sub-flow step can leave out its version: the flow version that runs it pins one when it's published (flow schema 1.10.0).**

- **Authoring:** `flowRef.version` is optional. A step that names a version runs that version, as before.
- **Publishing:** `POST /v1/flows` and a deploy pin each sub-flow step that names no version to the newest version of its flow that the project reaches, in the flow version's `pins.flows` (`FlowPins.flows`). That's the child version every run of the flow version runs. The publish is refused (`400 validation-failed`, each under `details.issues`) when the project reaches no version of the child, or when a step runs the flow itself with no version.
- **Deploying:** a deploy registers a flow before the flows that run it with no version, so they pin the version the deploy registered. A new child version renumbers the flows that run it (`pins-changed`, with a pin change of kind `flow`), as a new agent version does. Flows of one deploy that run each other with no version are refused, naming the cycle.
- **Comparing:** a flow candidate's `versions`, and the CLI's `--with`, can name the agents and tools of its sub-flows too, at any depth: a run's versions apply to every flow of the run.
- **Triggers:** `toolsAllowedUnattended` takes the tools of a sub-flow at the version the flow version pins. A step with no version and no pin adds none.
- `@kindgi/flow` exports `subflowVersion`, the version a sub-flow step runs, and `overridableTreeRefs`, what a run's versions can override in a flow and its sub-flows.
- A flow version published before has no `flows` pins, and its `pinsDigest` is unchanged.
