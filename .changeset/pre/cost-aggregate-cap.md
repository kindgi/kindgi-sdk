---
"@kindgi/api": patch
"@kindgi/client": patch
---

`GET /v1/cost/aggregate` returns at most 1000 groups by default: the most expensive ones. `groups` is ordered by `totalUsd`, highest first (ties by key, groups with no value last); before, the order was undefined and every group came back in one response, one per run for `groupBy=runId` over a long window. `?limit=` takes 1 to 10000 (anything else is `400 bad-input`). The response says when groups were left out: `truncated: true` and `totalGroups`, the count before the cap. `totalUsd`, `totalRecords` and `tokens` still cover every record. For every record, page through `/v1/cost/records`. **A caller that gets more than 1000 groups today gets 1000, with `truncated: true`**, unless it passes a larger `limit`. A `CostBinding` may cap in its own query (`CostAggregateInput.limit`, returning `totalGroups`); one that returns every group is capped by the route. `@kindgi/api` exports `COST_AGGREGATE_DEFAULT_LIMIT` and `COST_AGGREGATE_MAX_LIMIT`. The TypeScript and Python clients take `limit`.
