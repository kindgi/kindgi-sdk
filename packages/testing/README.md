# @kindgi/testing

Test helpers for Kindgi apps and packages.

## Purpose

`createApp` from [`@kindgi/api`](../api) requires a set of bindings
(conversations, run snapshots, kernel, tenant hierarchy, memory,
provenance) that a production deployment backs with the Kindgi runtime.
Most API tests exercise one route family and never touch the others.
`@kindgi/testing` supplies the rest as stubs, so a test can mount the real
app with no database and no runtime — and any code path that reaches an
unprovided binding fails loudly instead of silently returning nothing.

## Exports

| Export | Kind | Description |
|---|---|---|
| `createStubAppBindings()` | function | Every required `createApp` binding except `resolveToken` / `runHandler`, as stubs. |
| `createStubKernelBinding()` | function | Stub `KernelBinding` (each sub-binding stubbed; optional `eventBus` absent). |
| `createStubBinding<T>(name, methods)` | function | Stub any binding interface `T`; every method throws `StubBindingError`. |
| `StubBindingError` | class | Thrown by stub methods; carries `binding` and `method`. |
| `StubAppBindings`, `StubMethods<T>` | types | Return type of `createStubAppBindings`; the method map `createStubBinding` requires. |

## Example

```ts
import { createApp } from '@kindgi/api';
import { createStubAppBindings, createStubBinding } from '@kindgi/testing';

const app = createApp({
  ...createStubAppBindings(),
  resolveToken: async () => ({ tenantId }),
  runHandler: createStubBinding<RunHandlerBinding>('runHandler', {
    invokeAgent: true,
    invokeFlow: true,
    resumeRun: true,
  }),
  // The binding this test actually exercises — your in-memory
  // implementation or test double of AgentRegistryBinding:
  agentRegistry: myAgentRegistry,
});

const res = await app.request('/v1/agents', { headers: { authorization: 'Bearer t' } });
```

`createStubBinding` requires one `true` entry per interface method — the
map is type-checked for completeness, so a method added to the interface
(or a stale entry) fails to compile rather than surfacing at runtime.

## Non-goals

- **Behavioral fakes.** Stubs never return data. When a test needs a
  binding to behave, pass an in-memory implementation or a hand-written
  double for that binding and keep the stubs for the rest.
- **Database-backed integration.** Tests that need real persistence run
  against real adapters, not this package.
