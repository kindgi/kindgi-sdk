---
"@kindgi/api": patch
---

`409 block-project-mismatch` no longer names the project a block belongs to, as the agent, flow, tool and eval-suite mismatches don't. A caller who can't read that project shouldn't learn it.
- **The answer:** the error's `details` drop `projectId`, keeping `blockId`. The message says `Block "<id>" belongs to another project; publish its versions there`.
- **The log:** the request's log keeps the project, as `ownerProjectId`.
- **Unchanged:** the status and code. The binding's `project-mismatch` outcome still carries `projectId`, for the log.
