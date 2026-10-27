---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**A deploy refused because its pack's ids belong to another project names the fix the runtime has.** `409 agent-project-mismatch` (and `tool-…`, `flow-…`, `guardrail-…`, `block-…`) on a deploy names a copy of the pack (`kindgi init`, with its own pack id) only where each deployment runs as a service of its own. Where one pack service runs every deployment, such as a self-host serving one tenant, a copy's code wouldn't run, so it names an environment order instead: put both projects in one order (`kindgi environments set`) and `kindgi promote` the build to the second. With no environment orders either, it names no fix. The projects docs and the WooCommerce template's README say the same.
