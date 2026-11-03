---
"@kindgi/tools": patch
"@kindgi/agents": patch
---

**A run's record of a call its connections stopped says whose connection the call needed.** A refused connection record in the run's journal gains `as`: `company`, or `person`, the run's person. Records from before have none.

- `@kindgi/tools`: `ConnectionGateRecord` and `RecordedConnection`, the record a call's connection gate keeps in the run's journal, never with a token; `connectionGateRecordOf`, which builds it from the resolver's answer and the tool's needs; and `CONNECTION_GATE_RECORD_PREFIX`, its key's prefix. A runtime's flow tool step records the same shape.
- `@kindgi/agents`: the connection gate builds its record with `connectionGateRecordOf`.
