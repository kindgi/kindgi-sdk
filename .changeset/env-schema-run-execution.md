---
"@kindgi/env-schema": patch
---

**Three settings for a server that runs more than one instance, which runtime 0.7.0 reads.** `KINDGI_RUN_EXECUTION` says where runs execute: `local` (the default), in the process that starts them, or `request`, each inside a request of its own. With `request`, starting or resuming a run adds a task to the Cloud Tasks queue `KINDGI_TASKS_QUEUE`, which posts it to `<KINDGI_SERVICE_URL>/internal/execute` with a Google-signed ID token of `KINDGI_SERVICE_ACCOUNT`, the server's own account, and any instance takes it. The server then holds no request to itself, so a server whose CPU is allocated only during requests (Cloud Run's request-based billing) may run as many instances as its load needs. The Cloud Run module's new `server_run_execution = "request"` sets all four.
