// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ConversationBinding, RunSnapshotBinding } from '@kindgi/agents';
import type { CreateAppInput } from '@kindgi/api';
import type { MemoryQueryBinding } from '@kindgi/memory';
import type { TenantHierarchyBinding } from '@kindgi/platform';
import type {
  KernelBinding,
  RunBinding,
  RunRetentionBinding,
  SchedulerBinding,
  TriggerRegistryBinding,
  WaitpointBinding,
} from '@kindgi/runtime';

import { createStubBinding } from './stub-binding.js';

/**
 * The bindings `createApp` requires that tests usually don't exercise —
 * everything in `CreateAppInput` that is mandatory except the
 * caller-specific `resolveToken` and `runHandler`.
 */
export type StubAppBindings = Pick<
  CreateAppInput,
  | 'conversationBinding'
  | 'runSnapshotBinding'
  | 'kernelBinding'
  | 'tenantHierarchyBinding'
  | 'memoryBinding'
  | 'provenanceBinding'
>;

/**
 * Stubs for every required `createApp` binding. Mount the API for
 * contract, route-shape, and handler tests without a database or the
 * Kindgi runtime; any route that reaches one of these bindings fails
 * loudly with a `StubBindingError` naming the binding and method.
 *
 * Override the ones a test needs:
 *
 * ```ts
 * const app = createApp({
 *   ...createStubAppBindings(),
 *   resolveToken,
 *   runHandler,
 *   agentRegistry: myInMemoryAgentRegistry,
 * });
 * ```
 */
export function createStubAppBindings(): StubAppBindings {
  return {
    conversationBinding: createStubBinding<ConversationBinding>('conversationBinding', {
      openConversation: true,
      getConversation: true,
      listConversations: true,
      listConversationsPage: true,
      closeConversation: true,
      deleteConversation: true,
      appendMessage: true,
      readMessages: true,
    }),
    runSnapshotBinding: createStubBinding<RunSnapshotBinding>('runSnapshotBinding', {
      write: true,
      read: true,
    }),
    kernelBinding: createStubKernelBinding(),
    tenantHierarchyBinding: createStubBinding<TenantHierarchyBinding>('tenantHierarchyBinding', {
      createOrg: true,
      createTeam: true,
      createProject: true,
      addTeamMember: true,
      addProjectMember: true,
      removeTeamMember: true,
      updateTeamMemberRole: true,
      removeProjectMember: true,
      updateProjectMemberRole: true,
      getTenant: true,
    }),
    memoryBinding: createStubBinding<MemoryQueryBinding>('memoryBinding', {
      listFacts: true,
      searchByKeyword: true,
      searchBySemantic: true,
      appendLog: true,
      readLog: true,
    }),
    provenanceBinding: createStubBinding<CreateAppInput['provenanceBinding']>('provenanceBinding', {
      listRecords: true,
      getByRunId: true,
      getCallUsage: true,
    }),
  };
}

/**
 * Stub `KernelBinding`: each sub-binding is a stub named
 * `kernelBinding.<sub>`. The optional `eventBus` is omitted (absent), so
 * code that feature-checks it takes the no-event-bus path.
 */
export function createStubKernelBinding(): KernelBinding {
  return {
    run: createStubBinding<RunBinding>('kernelBinding.run', {
      runGraph: true,
      resumeRun: true,
      cancelRun: true,
      cancelToken: true,
      completeToken: true,
      readJournal: true,
      startRun: true,
      deleteRun: true,
      getRun: true,
      listRuns: true,
    }),
    scheduler: createStubBinding<SchedulerBinding>('kernelBinding.scheduler', {
      startCronScheduler: true,
      startEventTriggerScheduler: true,
      fireByWebhookId: true,
      initialNextFireAt: true,
    }),
    waitpoint: createStubBinding<WaitpointBinding>('kernelBinding.waitpoint', {
      startTimeoutSleeper: true,
    }),
    retention: createStubBinding<RunRetentionBinding>('kernelBinding.retention', {
      createRetentionAdapter: true,
    }),
    triggers: createStubBinding<TriggerRegistryBinding>('kernelBinding.triggers', {
      register: true,
      update: true,
      list: true,
      get: true,
      pause: true,
      resume: true,
      unregister: true,
      fetchActiveByWebhookId: true,
      listFires: true,
      fireNow: true,
      setOwner: true,
    }),
  };
}
