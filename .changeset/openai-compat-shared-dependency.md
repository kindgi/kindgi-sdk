---
"@kindgi/adapter-model-openai-compat": patch
---

`@kindgi/adapter-model-openai-compat` now lists `@kindgi/adapter-model-shared` in its `dependencies`. It imports the shared retries and typed errors from it when it runs, but listed it only as a dev dependency, so an install that didn't bring the shared package some other way failed to load the adapter with `ERR_MODULE_NOT_FOUND`.
