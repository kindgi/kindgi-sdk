---
"@kindgi/agents": patch
---

**A replay turn reads a recorded result that was outside data as data, as the past run did.** A `recorded` decision (`ReplayToolDecision`) can carry `fromEvent: true`: the past run kept the result as outside data, such as another system's answer to a paused call. The replay stores the result with that mark (`fromEvent`), and the model reads it as an event's data block, in that turn and in every later turn's history. A recorded result of a tool whose results are outside data (`resultIsOutsideData`) is data even without the mark. Before, a replay stored and sent every recorded result as plain text, though the past run's model had read it as data. A refused call's result is unchanged. A runtime's `ReplayBinding` passes the mark from the past run's tool message.
