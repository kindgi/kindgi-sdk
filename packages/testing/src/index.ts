// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/testing` — test helpers for Kindgi apps and packages.
 *
 * The stub bindings live in `@kindgi/api/testing`, beside the
 * `CreateAppInput` they stub, so `@kindgi/api`'s own tests use them with no
 * dependency on this package (which would be a cycle). They're re-exported
 * here unchanged.
 */

export {
  StubBindingError,
  createInMemoryTriggerRegistry,
  createStubAppBindings,
  createStubBinding,
  createStubKernelBinding,
  type InMemoryTriggerRegistry,
  type StubAppBindings,
  type StubMethods,
} from '@kindgi/api/testing';
