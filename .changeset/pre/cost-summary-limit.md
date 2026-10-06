---
"@kindgi/client": patch
---

`client.cost.usage.summary()` takes `limit`, the most groups to return (the most expensive ones), as the API's `?limit=` and the Python client's `limit=` do. The result's `truncated` and `totalGroups` say when there were more.
