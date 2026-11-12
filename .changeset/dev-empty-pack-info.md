---
"@kindgi/handler-runtime": patch
"@kindgi/cli": patch
---

`kindgi dev` on a pack with no primitives yet no longer leaves the runtime warning that the pack service isn't answering. No pack service starts until the first primitive, so the runtime's check at startup found nothing to answer it. Now the local pack service answers that check for the pack: its id and version from the config, no tools and no checks. So the runtime's startup line names the pack with 0 tools and 0 checks. The first primitive starts the pack service as before. In `@kindgi/handler-runtime`, the pack service supervisor has `serveEmpty(pack)`. While no child serves, `GET /v1/info` answers 200 with that pack, no tools and no checks, and `artifactVersion` `none`. `/readyz` and calls still answer 503, and the next `start` or `stop` ends it. Its argument's type, `PackIdentity`, is exported from `@kindgi/handler-runtime/pack-service`.
