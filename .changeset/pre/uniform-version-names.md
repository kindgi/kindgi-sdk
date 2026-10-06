---
"@kindgi/client": patch
---

One name for a version's calls on every resource. `agents.versions.reinstate`, `tools.versions.list / get / unregister / reinstate` and `flows.versions.list / get / unregister / reinstate` join `blocks.versions` and `evalSuites.versions`; `flows.versions.unregister` returns `{ flowId, version, unregistered }`. `policies.publish` matches the Python client. The old names keep working, marked `@deprecated`, and will be removed in 0.2: `agents.reinstateVersion`; `tools.listVersions`, `getVersion`, `unregisterVersion` and `reinstateVersion`; `flows.versions(id)`, `getVersion`, `delete` and `reinstateVersion`; and `policies.author`.

The Python client gains `eval_suites.unregister(suite_id, version)`, as `agents.unregister`, beside `eval_suites.versions.unregister`.
