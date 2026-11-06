---
"@kindgi/agents": patch
"@kindgi/guardrails": patch
---

What an llm-judge guardrail's model call warns about, such as a temperature its model doesn't take, now comes back with the judgment: `CheckResult.warnings`, absent when the call warned about nothing. An agent turn adds those warnings to its own `warnings`, once per code as with its own calls, each message starting with the guardrail it judged for (`Guardrail "<id>"'s judge: `). That holds at the final answer and at each point inside the loop, and a step run again after a wait still says them.
