---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**A replay turn reads a recorded result that was outside data as data, as the past run did.** A `recorded` decision (`ReplayToolDecision`) can carry `fromEvent: true`: the past run kept the result as outside data, such as another system's answer to a paused call. The replay stores the result with that mark (`fromEvent`), and the model reads it as an event's data block, in that turn and in every later turn's history. A recorded result of a tool whose results are outside data (`resultIsOutsideData`) is data even without the mark. Before, a replay stored and sent every recorded result as plain text, though the past run's model had read it as data. A refused call's result is unchanged. A runtime's `ReplayBinding` passes the mark from the past run's tool message.

**A judged flow run keeps the mark too.** When a flow run is first judged, a tool call its agent step's turn made keeps `fromEvent: true` where the turn kept the result as outside data (`JudgedToolCall.fromEvent`; on the wire, an optional `fromEvent` on each call in the judged context's `flow.calls`). A runtime's replay of the flow run passes it on, so the agent step's model reads that result as data. A flow run judged before keeps no mark, and its replay reads those results as they came.
