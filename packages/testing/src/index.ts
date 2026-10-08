// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/testing` — test helpers for Kindgi apps and packages.
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
