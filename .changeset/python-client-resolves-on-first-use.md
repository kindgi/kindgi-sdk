---
"@kindgi/client": patch
---

The Python client's `Kindgi()` and `AsyncKindgi()` find their settings (`KINDGI_API_URL`, `KINDGI_API_TOKEN`, or the running `kindgi dev`) when they're first used, not when they're created, as the TypeScript client does. A module-scope `kindgi = Kindgi()` no longer breaks a build step that imports the app without them, such as Django's `collectstatic` or a Docker build running `manage.py`. When they're still missing, the first request (or reading `base_url` / `token`) raises the same `ValueError`, naming what to set. Once they're set, the next use works, and the found settings are kept.
