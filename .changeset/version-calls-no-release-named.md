---
"@kindgi/client": patch
---

**The old version calls' deprecations no longer say they are removed in 0.2.** The calls stay, deprecated, and send the same requests as before. A later minor release removes them, announced in advance.

- **The calls:** `agents.reinstateVersion`, `tools.listVersions`, `tools.getVersion`, `tools.reinstateVersion`, `tools.unregisterVersion`, `flows.getVersion`, `flows.delete`, `flows.reinstateVersion`, calling `flows.versions(id)` directly, and `policies.author`. Each one's docs name the call to use instead: the resource's `versions.list`, `versions.get`, `versions.reinstate` or `versions.unregister`, or `policies.publish`.
- **`flows.delete`'s docs** also say that it answers nothing, where `flows.versions.unregister` answers `{ flowId, version, unregistered }`.
- **Three docs that named the old calls** now name the new ones: `ToolVersionRow`'s, the policies client's and the retention client's.
