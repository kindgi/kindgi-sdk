---
"@kindgi/api": patch
---

The spec says what `GET /v1/provenance?agentId=` matches: the records of that agent's turns, at any version, by the agent the record's run names (as `GET /v1/runs?agentId=`). It said "a DAG node whose `actor` is the agent", which an agent turn never recorded.
