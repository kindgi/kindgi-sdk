---
"@kindgi/api": patch
"@kindgi/tools": patch
---

**`POST /v1/deployments` refuses a pack's tool whose version the runtime holds with another definition: `409 tool-already-registered`.** Before, a deploy kept the manifest the version already held and only moved its code pointer to the new image. So a tool changed under the same version, such as a new input schema, another `needsSpec` (whose account a connection uses, for one), `mutating` or its approvals, deployed "ok", and its new code ran under the old manifest. The deploy now checks each of the pack's tools before it writes anything, as it does the pack's data blocks:

- A version the runtime doesn't hold is published, as before.
- One it holds in the deploy's project with the same definition is kept, active or unregistered, as before. A new image of the same tool is the same definition: what a deploy derives (the image and artifact version in the code pointer, the version's project and secret scopes) isn't compared.
- One it holds in the deploy's project with another definition, active or unregistered, is refused. `details.fields` names the fields of its definition that differ (the manifest's top-level fields, and `modulePath` for where its code lives in the pack), and the message says to give the tool a new version. Nothing is written.
- A version in another project, or an MCP endpoint's tool, is refused as before (`tool-project-mismatch`, `tool-kind-mismatch`). One the runtime takes from another project of the project's environment order, and one published with another definition while the deploy runs, are refused at the write, and the deploy rolls back what it wrote.

A digest replay goes through the same check. So an image recorded before this release, whose tool the runtime kept with another definition, now gets `409 tool-already-registered` where it got `200`. Give the tool a new version and build again.

`@kindgi/tools` exports what the deploy compares: `toolDefinition` (a tool's declared fields, and its module path), `changedToolFields` and `sameToolDefinition`. The classification of the manifest's fields is typed over every field, so one a later release adds fails the typecheck until it's classified. The tools in `@kindgi/connections` take a new version whenever what they declare changes, and their tests pin each one's definition at its version.
