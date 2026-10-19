---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Cost filters to one flow.** `GET /v1/cost/records` and `GET /v1/cost/aggregate` take `flowId`: every record of the run trees whose root is a run of that flow, whatever its version. A flow's page can now show the flow's own spend (`groupBy=day&flowId=…`), where the aggregate could only group by flow before. In the TypeScript client, `cost.usage.query` and `cost.usage.summary` take `flowId`; in the Python client, `flow_id`.
