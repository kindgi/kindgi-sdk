---
"@kindgi/api": patch
---

**A deploy that failed after its tools were published no longer leaves its image undeployable.** Rolling back, `POST /v1/deployments` unregisters the tool versions it published. A tool's version numbers are single-use, so the next deploy of the same image found each such version already published but unregistered, and its agents and flows found no published version of the tool: `400 validation-failed` ("…use tool or agent versions that aren't published") until the pack was rebuilt under a new tool version. A deploy now reinstates a tool version its registry lists as unregistered, and rolling that deploy back unregisters it again.
- It reinstates the version under the rule `POST /v1/tools/{toolId}/versions/{version}/reinstate` holds: the version stored under that number is what comes back, and one that names a model provider's key stays unregistered (`400 deployment-validation-failed`, with an issue at the tool's `/secrets/<name>`).
- A tool version that's still active is never reinstated, so a registry that doesn't keep unregistered versions (as under `kindgi dev`) is never asked.
- This holds for a version its owner unregistered too: deploying an image that brings it brings it back, as a deploy brings back its agents and flows under their next free version.
