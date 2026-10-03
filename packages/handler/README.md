# @kindgi/handler

Kindgi™ pack-author authoring surface.

**Every handler you write against Kindgi runs against the contract in
this package.** Runtime implementations (such as the Kindgi runtime)
execute your handlers against these types.

Types plus one error class (`WaitpointCancelledError`); no other runtime
code.

## Exports

| Symbol | Kind | What it is |
| --- | --- | --- |
| `NodeHandler` | type | `(input: unknown, ctx: NodeContext) => Promise<HandlerResult \| unknown>` |
| `NodeContext` | type | What handlers receive: `runId`, `nodeId`, `tenantId`, `nodeOutputs`, `state`, `abortSignal`, `dryRun`, `principal?`, `authorize`, `can`, `check`, `clockNow`, `waitForToken` |
| `HandlerResult` | type | Optional structured return — `{ output, stateDelta? }` |
| `HandlerRegistry` | type | `ReadonlyMap<NodeId, NodeHandler>` |
| `LoopContext` | type | Loop annotation (`loopNodeId`, `iteration`, enclosing-loop `path`) on the journal entries of nodes that ran inside a loop body |
| `LoopNodeOutput` | type | Return shape of a loop node |
| `WaitpointCancelledError` | class | Thrown by `ctx.waitForToken(...)` when the wait is cancelled externally |

## What does NOT live here

- Wire-vocabulary types (`RunStatus`, `RunResult`, `JournalEntry`,
  trigger schemas, error shapes) — those are in **`@kindgi/runtime`**.
- Concrete runtime functions (`runGraph`, `resumeRun`, `cancelToken`,
  etc.) — the Kindgi runtime implements them; they are declared on
  `RunBinding` in `@kindgi/runtime` and reached through the
  `KernelBinding` plugged into `createApp`.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
