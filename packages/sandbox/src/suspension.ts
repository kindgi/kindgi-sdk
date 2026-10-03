// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Cross-process suspension primitive for the mode-B invocation model.
 * A handler running inside a
 * sandbox that needs to durably wait on an external token throws this
 * class from `ctx.waitForToken(tokenId)`; the handler-base entrypoint
 * catches it, emits a `SuspendFrame` on stdout, and exits with
 * `SUSPEND_EXIT_CODE` (42).
 *
 * NOT the same primitive as the kernel's `SuspensionSignal` —
 * that class is kernel-scoped (it references `NodeId` which is a flow
 * primitive) and lives in the same-process side of the wire. This one
 * is sandbox-side and lives strictly at the wire boundary; the kernel
 * translates a mode-B `suspended` outcome into its own
 * `SuspensionSignal` at dispatch time.
 *
 * Distinct from a plain `Error` so a handler's own `try { ... } catch
 * (e) { ... }` block cannot silently swallow it — a matching `catch`
 * that does not re-throw is a handler bug (the wait would silently
 * become a return-undefined instead of a suspend).
 */
export class SandboxSuspensionRequest extends Error {
  readonly tokenId: string;
  constructor(tokenId: string) {
    super(`Handler suspended on wait token "${tokenId}"`);
    this.name = 'SandboxSuspensionRequest';
    this.tokenId = tokenId;
  }
}
