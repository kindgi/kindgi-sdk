---
"@kindgi/guardrails": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

Guardrail outcomes: what each guardrail's checks came to, passes included, counted on the server.

- **The record:** an agent turn's guardrail gate records each check as `passed`, `violated` (the answer went through), `blocked` (a `halt` failed the turn) or `errored` (the check couldn't run). It records through `InvokeAgentBindings.guardrailOutcomes`, a `GuardrailOutcomeSink` from `@kindgi/guardrails`, before it acts on them, so a blocked turn is recorded too.
  - **No content:** only ids, the action, the severity and an error's code. No answer, and no check's reason.
  - **Not recorded:** replays and dry runs.
  - **Strict:** a sink that throws fails the step with `persistence-error`, so the counts never silently miss a turn.
  - **Without a sink,** nothing is recorded.
- **`categorizeOutcomes`** also answers `checks`, each guardrail's outcome in order.
- **`GET /v1/guardrails/{guardrailId}/outcomes`:** a guardrail's outcomes on a project's agent turns over a window. The answer has the `counts`, the same counts per agent version (`byAgentVersion`), the window's latest blocked turns (`recentBlocked`, run ids and times only) and `recordedSince`, the earliest outcome kept.
  - **The query:** `projectId`, `from` and `to` are required, with a window of at most 90 days. `recent` is optional: 0 to 50, 10 by default.
  - **Who:** it needs `read` on the guardrail and on the project.
  - **Retention:** outcomes go with their run's retention, so a window can hold fewer than asked.
- **`GuardrailRegistryBinding.outcomes`** is optional. Without it, the route answers `501 guardrail-outcomes-not-supported`.
- **The clients:** TypeScript `guardrails.outcomes(id, query)`; Python `guardrails.outcomes(...)`.
