---
"@kindgi/agents": patch
"@kindgi/api": patch
---

An agent's approval gates fail closed. A tool-call approval rejected with a `value` still ran the tool: `POST /v1/approvals/:id/complete` let a `value` replace the resume payload `{ decided, rationale }`, and the tool and session gates went on unless they read an explicit `reject`. Now only an explicit approve lets a tool run or a session go on; a reject, or an answer that isn't a decision at all, blocks, the tool call with a rejected result that says why. And the route refuses a `value` for an agent's tool-call or session gate (`tool-call:pending`, `agent-turn:session-hitl-gate`) with `400 bad-input`, before anything is recorded; another subject's approval still takes one. `@kindgi/agents` exports the gate subjects (`AGENT_GATE_SUBJECTS`, `TOOL_CALL_GATE_SUBJECT`, `SESSION_GATE_SUBJECT`) and `readGateDecision`.
