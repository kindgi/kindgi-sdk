---
"@kindgi/client": patch
---

**List pages drop `items`.** A list call answers the wire's page alone: `data`, `hasMore` and `nextCursor`. `items`, the name the client used for the list before pages took the wire's shape, was deprecated then and is gone now; read `page.data` instead. `ListPage<T>` no longer extends the store-side `Page<T>` from `@kindgi/types`, which keeps its own `items`.
