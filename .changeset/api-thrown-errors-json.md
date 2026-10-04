---
"@kindgi/api": patch
---

An exception a route throws now reaches the client as a `500 internal-server-error` wire error, as JSON with its message and the request id. Before, Hono's own error handler answered first with plain-text "Internal Server Error", so the JSON error mapper never ran and clients got an unparseable 500. The mapping is now the app's error handler (`app.onError`); an exception that carries its own response (Hono's `HTTPException`) still answers with it.
