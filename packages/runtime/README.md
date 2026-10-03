# @kindgi/runtime

Kindgi™ runtime wire-vocabulary + binding interfaces.

The public shape of everything that flows across the Kindgi runtime
boundary: what a run looks like, what a journal entry looks like,
what triggers a run, and how a deployment plugs its runtime
implementation into `createApp`.

Types and pure derivation functions — no runtime state, and no
dependency on a runtime implementation.

## What lives here

### Wire vocabulary
- `RunStatus`, `RunResult`, `RunOptions`
- `JournalEntry`, `JournalKind`
- All fanout / subgraph / iteration / step payload types
- Kernel error shapes (`KernelError`, `RunNotFoundError`,
  `HandlerMissingError`, `WaitpointError`, …)
- Versioning envelope + `wrap` / `unwrap` + `EnvelopeError` variants
- Event-bus channel + `KernelEventBusBinding`
- Derivation helpers (`deriveRunState`, `normalizeHandlerResult`,
  `waitResolutionKey`) — pure functions over journal shape

### Run inputs and records
- `RunFlowInput`, `ResumeRunInput`, `StartRunParams`, `DeleteRunParams`
  and their error shapes
- `FlowResolver` (sub-flow lookup), `HandlerResolver` (handlers for each
  child flow), `ParentRunRef` (the parent node of a child run)
- `KernelRunRecord` (with `output` and the `parentRunId` /
  `parentNodeId` / `parentScope` fields), `ListRunsInput` (content scope,
  `parent`, `topLevelOnly`), `ListRunsPage`

### Trigger surface
- `CronTriggerRecord`, `EventTriggerRecord`, `WebhookTriggerRecord`
- All `Register*Input` / `Update*Input` variants + `Get`/`List` inputs
- `TriggerRegistryBinding` (the caller-plugged binding)
- `RunFlowBinding` (turns a trigger fire into a run), `TriggerFireContext`,
  `TriggerSource`, trigger config and error shapes
- `TRIGGER_KINDS`, `TriggerKind`

### Binding interfaces (deployment-plug-in contract)
- `RunBinding` — `runGraph`, `resumeRun`, `cancelRun`, `cancelToken`,
  `completeToken`, `readJournal`, `startRun`, `deleteRun`, `getRun`,
  `listRuns`
- `SchedulerBinding` — scheduler lifecycle
- `WaitpointBinding` — waitpoint-timeout sleeper
- `RunRetentionBinding` — retention adapter
- `KernelBinding` — umbrella that groups all four plus
  `TriggerRegistryBinding` + `KernelEventBusBinding`. What
  `CreateAppInput.kernelBinding` accepts.

## What does NOT live here

- Pack-author authoring surface (`NodeHandler`, `NodeContext`,
  `HandlerResult`, `HandlerRegistry`, `LoopContext`,
  `WaitpointCancelledError`) — those are in **`@kindgi/handler`**.
- Concrete runtime functions — the Kindgi runtime implements them,
  reached through the `KernelBinding` interface plugged into
  `createApp`.
- Storage schema and migrations — implementation details of the Kindgi
  runtime.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
