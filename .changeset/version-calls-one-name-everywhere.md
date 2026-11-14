---
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**Every resource's version calls now live under `versions`.** Policies, schedules, webhooks, mail triggers, queue rules and secrets get the names agents, blocks, flows, tools, release gates and test sets already have: `versions.list`, `versions.get`, `versions.unregister` and `versions.reinstate`, as far as the API has each call. Their old names still work, deprecated, and send the same requests as before. The 0.8.0 release removes them.

- **Policies:** `policies.versions.list`, `versions.get`, `versions.unregister` and `versions.reinstate`, in place of calling `policies.versions(id)` directly, `getVersion`, `unregister` and `reinstateVersion`. `versions.unregister` answers `{ policyId, version, unregistered }`, where `policies.unregister` answers nothing.
- **Schedules, webhooks and mail triggers:** `versions.list` and `versions.get`, in place of calling `versions(triggerId)` directly and `getVersion`. A trigger's version is still its number.
- **Queue rules:** `projects.queueRules.versions.list`, in place of calling `projects.queueRules.versions(projectId, ruleId)` directly.
- **Secrets:** `secrets.versions.list` and `secrets.versions.get`, in place of `listVersions` and `getVersion`. They take the same input objects, and `versions.get` still answers `null` for a version that isn't there.
- **Each old `versions` you could call** still takes and answers what it did. Its deprecation sits on the call alone, so an editor strikes through `policies.versions(id)` and not `policies.versions.list`.
- **Code that implements one of these clients itself**, such as a typed test fake, adds the new `versions` members; calls don't change.
- **Every version client is exported, and so are the unregister and reinstate results**, among them `PolicyVersionsClient`, `UnregisterPolicyVersionResult`, and the agent, flow and tool ones that weren't exported yet, such as `FlowVersionsClient`. So is `ToolVersionRow`, the row `tools.versions.list` answers.
- **`@kindgi/sdk/client` re-exports them too**: every version client, `FlowVersionRow`, `PolicyVersionRow`, `ToolVersionRow`, and the unregister and reinstate results. The TypeScript reference then documents each resource's version calls.
- **The CLI calls the new names.** Its commands and their output don't change.
