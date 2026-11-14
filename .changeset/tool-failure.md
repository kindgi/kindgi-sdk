---
"@kindgi/tools": minor
"@kindgi/sdk": minor
"@kindgi/handler-runtime": minor
"@kindgi/agents": minor
"@kindgi/policy-contract": minor
"@kindgi/api": minor
"@kindgi/specs": minor
"@kindgi/pack-conformance": minor
"@kindgi/client": minor
---

**A tool can fail a call on purpose, with its own code and words for a person.** `` throw new ToolFailure('order-not-found', `No order ${orderId}`, { details: { orderId } }) `` (`@kindgi/sdk/define`; `ToolFailure` in Python, `ToolFailureException` in Java and Scala) fails the call with `tool-failed`, a new code beside the crash's.

- **The call's error.** `invokeTool` answers `ToolFailedError`: `{ code: 'tool-failed', message, toolId, reason, details? }`. The tool's code is `reason`, its words are the message as written, with no lead-in and no cause, and `details` are its facts. The message and every string in the details are masked as a thrown message is.
- **The rules.** The code is kebab case, a letter first, at most 64 characters: a fixed word, since runs are grouped by it. The message isn't empty and is cut at 1,000 characters. The details are a JSON object of at most 4 KiB as JSON. A value the class refuses throws a `TypeError`, so the call is a crash that says why, and so is a `ToolFailure` changed after it was made. `isToolFailure` tells one by its brand, so another copy of the package agrees.
- **Pack protocol 2.12.0.** The error answer's codes gain `tool-failed`, with `reason` and `details`; `v` stays 2. The TypeScript, Python and Java pack services answer it, and the conformance suite has a fixture tool for it, `conformance.fails-on-purpose`, in each language.
- **In an agent.** `tool-failed` is a `toolErrors` kind of its own, out of the default and not covered by `tool-error`. With it in `retryOn`, the call goes back to the model with the tool's code, words and details, and an instruction to tell the person or try another way. Otherwise, or past the retries, the turn fails with `ToolFailedTurnError`, `tool-failed` at the top: `{ code, message, toolId, reason, details?, toolRetries? }`. The `tool.failed` stream event says `tool-failed` and the tool's code as `reason`, without the details.
- **A run's failure.** `Run.failure` for it has the tool's code as `reason`, its details whole in `details`, and the tool as `cause`: `{ toolId }`. The API answers the turn's error with `422`. The OpenAPI document says so, and an agent's `toolErrors.retryOn` takes `tool-failed`, in the agent schema and the clients too.

A check that throws a `ToolFailure` fails as any throw does.

Release-decision: 0.7.0, the maintainers, 2026-11-06T22:04:22Z
