---
"@kindgi/client": patch
---

**Every resource's version calls now live under `versions`.** Policies, schedules, webhooks, mail triggers, queue rules and secrets get the names agents, blocks, flows, tools, release gates and test sets already have: `versions.list`, `versions.get`, `versions.unregister` and `versions.reinstate`, as far as the API has each call. Their old names still work, deprecated, and send the same requests as before. A later minor release removes them, announced in advance.

- **Policies:** `policies.versions.list`, `versions.get`, `versions.unregister` and `versions.reinstate`, in place of calling `policies.versions(id)` directly, `getVersion`, `unregister` and `reinstateVersion`. `versions.unregister` answers `{ policyId, version, unregistered }`, where `policies.unregister` answers nothing.
- **Schedules, webhooks and mail triggers:** `versions.list` and `versions.get`, in place of calling `versions(triggerId)` directly and `getVersion`. A trigger's version is still its number.
- **Queue rules:** `projects.queueRules.versions.list`, in place of calling `projects.queueRules.versions(projectId, ruleId)` directly.
- **Secrets:** `secrets.versions.list` and `secrets.versions.get`, in place of `listVersions` and `getVersion`. They take the same input objects, and `versions.get` still answers `null` for a version that isn't there.
- **Each old `versions` you could call** still takes and answers what it did. Its deprecation sits on the call alone, so an editor strikes through `policies.versions(id)` and not `policies.versions.list`.
- **Code that implements one of these clients itself**, such as a typed test fake, adds the new `versions` members; calls don't change.
- **Every version client and its result types are exported**, among them `PolicyVersionsClient`, `UnregisterPolicyVersionResult` and the ones agents, flows and tools already had, such as `FlowVersionsClient`.
- **The CLI calls the new names.** Its commands and their output don't change.
