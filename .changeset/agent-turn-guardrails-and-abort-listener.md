---
"@kindgi/agents": patch
"@kindgi/guardrails": patch
---

An agent that lists a guardrail more than once now runs its check once a step, so an llm-judge check is called, and billed, once. An unknown id listed twice is named once in `unresolved-guardrail`. A retried step whose guardrail checks came to none now records that, so the outcome counts hold only the last attempt's checks; a first attempt with none still writes nothing. A `GuardrailOutcomeSink` of your own gets that record with empty `checks`, and should leave the step with no outcomes, as recording a step again replaces what it recorded. Each step of a turn now removes the listener it adds to its run's abort signal when it settles, so a turn of more than ten steps no longer logs `MaxListenersExceededWarning`.
