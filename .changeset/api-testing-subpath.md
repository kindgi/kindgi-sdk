---
"@kindgi/api": patch
"@kindgi/testing": patch
---

`@kindgi/api/testing` holds the stub bindings for `createApp` (`createStubAppBindings`, `createStubKernelBinding`, `createStubBinding`, `StubBindingError`, `createInMemoryTriggerRegistry` and their types). `@kindgi/testing` re-exports them unchanged and now depends only on `@kindgi/api`. This removes the workspace's only dependency cycle: `@kindgi/api`'s tests used `@kindgi/testing`, which depends on `@kindgi/api`, so a fresh checkout's `pnpm -r build` could build them in the wrong order. `pnpm run check:cycles`, now in CI, keeps the workspace free of cycles.
