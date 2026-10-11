// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/api/testing`: typed, fail-loud stub bindings for `createApp`,
 * for tests that mount the API without a database or the Kindgi runtime.
 * They live here, beside the `CreateAppInput` they stub, so `@kindgi/api`'s
 * own tests use them without depending on `@kindgi/testing` (which
 * re-exports them, unchanged).
 */

export {
  createStubAppBindings,
  createStubKernelBinding,
  type StubAppBindings,
} from './app-bindings.js';
export { StubBindingError, createStubBinding, type StubMethods } from './stub-binding.js';
export {
  createInMemoryTriggerRegistry,
  type InMemoryTriggerRegistry,
} from './trigger-registry.js';
