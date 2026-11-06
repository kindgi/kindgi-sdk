---
"@kindgi/api": patch
"@kindgi/client": patch
---

Unregistering a tool or agent version can answer `lockedBy`: what can still run the version. That's each agent and flow version that locks it, and each unregistered agent version a registered flow version still runs (`unregistered: true`), sorted by kind, id, then version. `[]` says nothing locks it. Runs in flight aren't listed. The answer has it when the deployment wires the new optional `versionLocks` binding (`VersionLocksBinding`) into `createApp`. Without it, or when its read fails, the answer is as before, and a failed read is logged by the error's name only. `client.tools.versions.unregister` and `client.agents.versions.unregister` return it. In the OpenAPI document, `UnregisterToolResult` and `UnregisterAgentResult` gain the optional `lockedBy`, and `VersionLock` is new.
