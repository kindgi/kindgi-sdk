---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**A gate policy is now a release gate.** This is a breaking rename, and no old name is kept.

- **Routes.** `/v1/gate-policies` is `/v1/release-gates`, with the same paths below it (`/{releaseGateId}`, `/versions`, `/versions/{version}`, `.../unregister` and `.../reinstate`), and an agent's `/gate-policy` is `/release-gate`. The operation ids `gatePolicies.*` and `agents.gatePolicy.resolve` are `releaseGates.*` and `agents.releaseGate.resolve`, under the tag `release-gates`.
- **Fields.** A release gate's `policyId` is `releaseGateId`. The release gate a pin names is `releaseGate` (was `policy`): on a pin and in the pin history, in a pin check's answer, in a refused pin's `details`, in a `pin-gate-unsupported` answer, in a deployment promotion's pin gate, and in the answer of `GET /v1/agents/{agentId}/release-gate`.
- **Metrics.** A test run comparison's `weightedYesShare` is `passRate`, and its `judgedCoverage` is `caseCoverage`. So are the metric names in a release gate's spec, and the `objective` of a suggested change, an Improve run, a schedule's Improve run and the Improve run webhook event (`passRate`, the default, or `weightedPrecisionAtK`). The CLI's `--objective` takes the same values.
- **Checks.** The gate's check `baselineIsLive` is `baselineIsPinned`.
- **Errors.** `gate-policy-not-found`, `gate-policy-already-registered`, `gate-policy-scope-taken`, `gate-policy-scope-changed`, `gate-policy-scope-unpinned`, `gate-policy-needs-pin` and `gate-policy-descendant-unpinned` are `release-gate-not-found`, `release-gate-already-registered`, `release-gate-scope-taken`, `release-gate-scope-changed`, `release-gate-scope-unpinned`, `release-gate-needs-pin` and `release-gate-descendant-unpinned`, with the same statuses and bodies.
- **Removed.** A spec's `approvals.forRollback`: going back is a pin, which the gate already checks. The key is now refused like any other unknown key.
- **Schemas and types.** `GatePolicy`, `GatePolicyPage`, `GatePolicyRef`, `GatePolicyResolution`, `GatePolicySpec` and `PublishGatePolicyBody` are `ReleaseGate`, `ReleaseGatePage`, `ReleaseGateRef`, `ReleaseGateResolution`, `ReleaseGateSpec` and `PublishReleaseGateBody`. A runtime implements `ReleaseGateBinding` (was `GatePolicyBinding`) under `AgentPinBindings`' `releaseGates` (was `gatePolicies`), with `ReleaseGateError`, `ReleaseGateErrorCode`, `ReleaseGateListInput`, `ReleaseGatePublishInput` and `ReleaseGateVersionInput`.
- **TypeScript client.** `client.gatePolicies` is `client.releaseGates`, and `client.agents.gatePolicy` is `client.agents.releaseGate`. Its types are `ReleaseGatesClient`, `ReleaseGateVersionsClient`, `AgentReleaseGateClient`, `ReleaseGateFilter` and `PublishReleaseGateInput`.
- **CLI.** `kindgi gate-policies` is `kindgi release-gates`, `kindgi agents gate-policy` is `kindgi agents release-gate`, `<policy-id>` is `<release-gate-id>`, and `--policy-version` is `--release-gate-version`. In an export, the kinds `gate-policies` and `gate-policy-versions` are `release-gates` and `release-gate-versions`. Don't resume an export that an earlier CLI started. Run it again into a new folder; resuming writes the new kinds beside the old ones.
