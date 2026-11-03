---
"@kindgi/api": patch
"@kindgi/compliance": patch
"@kindgi/client": patch
---

**Who published a block version, and where it came from.** A block version now records `publishedBy` (`{ kind: "user" | "service", id }`, the caller) and `source`: `{ kind: "api" }` for `POST /v1/blocks`, `{ kind: "deploy", id }` with the deployment's id for a version a deploy's pack brought, and `{ kind: "suggested-change", id }` for one a suggested change published. `GET /v1/blocks/{blockId}` and its versions answer both. A version published before they were recorded has neither. `BlockPublishInput` takes both, so a store keeps them. A deploy mints its deployment's id before it publishes the pack's blocks, and `DeploymentRegisterInput.deploymentId` passes it to the store.

**A block an agent version uses as its model settings takes only model settings.** `POST /v1/blocks` refuses a new settings version of such a block when its values aren't model settings, or name the model an agent version that uses it names too (`400 validation-failed`, naming the agent version). A deployment answers which agent versions use a block through the new `BlockUseBinding` (`blockUse` on the app). Without it, the publish isn't checked this way.

**Audit events.** Publishing, unregistering and reinstating a block version (`block-version-published`, `block-version-unregistered`, `block-version-reinstated`), and registering and unregistering a model provider (`provider-registered`, `provider-unregistered`), are recorded with the caller as their actor. A deploy records each block version it publishes once its deployment is recorded. The events name the block and version, or the provider and its adapter, and never a block's content or a provider's key.
