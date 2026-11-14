---
"@kindgi/agents": patch
---

**A typed agent's output repairs count from where the turn's loop starts.** A message of the person's that starts with the repair marker (`[kindgi:output-repair]`), this turn's or one in the conversation's history, no longer uses up the turn's repairs (`output.maxRepairs`). Before, each one counted as a repair, so a typed agent's turn could fail with `output-schema-violation` before the model was asked to fix its answer. Now only the repair messages the turn's loop added count, as the turn's tool retries and `retry` guardrail notes already do.
