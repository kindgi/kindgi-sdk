# `@kindgi/testing` — Specification

## Purpose in the framework

Public packages define binding interfaces; implementations are supplied
by the host. Tests of a public package need *some* value for every
required binding even when the code under test never calls it. This
package is the one sanctioned way to supply those values, so tests of
public packages never depend on a runtime implementation.

## Design principles

1. **Fail loud.** A stub method throws `StubBindingError` synchronously —
   including methods whose real signature returns a `Promise` — so a test
   that unexpectedly reaches a stubbed path fails at the call site with a
   message naming `binding.method`, never with a silent `undefined`.
2. **Complete at compile time.** `createStubBinding<T>(name, methods)`
   takes a `{ [K in keyof T]-?: true }` map. Missing and extra keys are
   type errors, so stubs track interface changes mechanically.
3. **Absent means absent.** Optional bindings (e.g. `KernelBinding.eventBus`)
   are omitted, not stubbed, so feature checks (`binding.x !== undefined`)
   take the "not configured" branch exactly as in a minimal deployment.
4. **No shared state.** Every call returns fresh objects; stubs hold no
   state and cannot leak between tests.

## Scope

`createStubAppBindings()` covers exactly the bindings `CreateAppInput`
marks required, minus `resolveToken` and `runHandler` — those encode the
test's identity and run semantics and are always supplied by the test.
Its return type is `Pick<CreateAppInput, …>`, so it tracks `createApp`'s
contract directly.
