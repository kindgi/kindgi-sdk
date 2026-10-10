# @kindgi/testing

## 0.1.5-rc.0

### Patch Changes

- 9801f25: `@kindgi/api/testing` holds the stub bindings for `createApp` (`createStubAppBindings`, `createStubKernelBinding`, `createStubBinding`, `StubBindingError`, `createInMemoryTriggerRegistry` and their types). `@kindgi/testing` re-exports them unchanged and now depends only on `@kindgi/api`. This removes the workspace's only dependency cycle: `@kindgi/api`'s tests used `@kindgi/testing`, which depends on `@kindgi/api`, so a fresh checkout's `pnpm -r build` could build them in the wrong order. `pnpm run check:cycles`, now in CI, keeps the workspace free of cycles.
- b67c599: Agents recall earlier conversations, and a conversation can be unregistered.
  
  - **Recall.** A retrieval intent with `source: 'conversations'` recalls messages of this agent's earlier conversations (a user's message or an agent's answer; tool calls are not indexed). It has no `types`, and its scopes are:
    - `same-user` (the usual choice): this end user's, or this user's, other conversations;
    - `same-conversation`: this conversation's messages older than the history window (`conversationPolicy.historyLimit`);
    - `same-segment`: conversations in the run's segment path (the same customer);
    - `same-project`: the project's conversations.
  
    `mode` works as for facts: absent (newest first), `keyword`, `semantic` (needs embeddings, else `semantic-unavailable`) or `both` (fused by rank).
  - **The people's own words, by default.** Recall returns users' messages only. `roles: ['user', 'agent']` adds the agent's earlier answers, which can carry its mistakes: they are quoted with `note: "earlier answer by the agent, not verified"`, and publishing warns `recall-agent-answers` (once per agent). Neighbouring messages follow the same roles.
  - **Other people's conversations.** `same-segment` and `same-project` recall them, in the run's own project only. Publishing such an agent warns `recall-other-people`, and in the prompt each of their messages is marked `anotherPerson`, without saying whose. Recall is always this agent's conversations, within what the run may recall (`isRecallReadableBy` in `@kindgi/memory`: a conversation is always someone's).
  - **The prompt.** Recalled messages are quoted in the `<memory>` block after the facts: the date, the message, and the messages either side. They are earlier conversation, never turns. The system message's memory line now names quotes from earlier conversations. **This changes what models see.**
  - **The turn.** `AgentTurnResult.recalled` (optional) and the journal keep what was recalled, with each message's ranks. A replay can reuse the past run's (`ReplayBinding.recalled`). The run's provenance has a `retrieval` node per recalled message (`source: conversations`), `retrieved-from` its intent's `search_memory` node.
  - **The binding contract** (additive: each new method and field is optional):
    - `MemoryQueryBinding.searchConversations?` (`SearchConversationsInput`, `RecallHit`, `RecalledMessage`). Without it, such an intent recalls nothing, and the journal says so (`degraded: no-recall`). Publishing warns `recall-unavailable` (`MemoryBinding.conversationRecall`).
    - `AppendMessageInput.recall` (the turn's user and segments, for the index).
    - `ReadMessagesInput.beforeSequence`/`last`: a turn now reads only its history window.
  - **Unregister.** `POST /v1/conversations/{id}/unregister` tombstones a conversation (`Conversation.unregisteredAt`). From then on no read, list or recall returns it, and it takes no more turns. The retention sweep removes it after the tenant's grace. `ConversationBinding.unregisterConversation?` (501 `conversation-unregister-unsupported` without it). The TS client has `conversations.unregister`, and so do the Python client and `kindgi conversations unregister`. `deleteConversation` is deprecated: it left a conversation's messages behind. It is optional now, and the next release drops it.
  - **Specs.** The agent spec (schema-version 1.6.0) has `source` and `same-segment`: an intent over facts needs `types`, one over conversations has none.
- d7d5c45: Schedules run an agent or a flow, as their owner, with a catch-up and an overlap policy, a fire history and run-now. There's also a `kindgi schedules` command group.
  
  **`/v1/schedules`:**
  - **What it runs:** a schedule names `flowId` with `flowVersion`, or `agentId` (with an optional `agentVersion`; without one, its live version, as a run that names none).
  - **An agent schedule's input** is the agent payload, so `config.input.userMessage` is required (400 without it, on register or when a change would leave it out); a flow schedule's input is the flow's own.
  - **`projectId`:** default, the tenant's default project.
  - **`owner`:** the principal that registered it. Its runs act as the owner, checked again at every fire.
  - **`catchUp`:** after a gap, `latest` (the default) runs once for the latest missed occurrence, and its fire says how many it missed; `skip` drops them. Never a run per missed occurrence.
  - **`overlap`:** while the previous run is still going, `skip` (the default) records the fire as skipped; `allow` starts another.
  - **`startingDeadlineSeconds`:** default 600.
  - **`statusReason`:** set when the runtime paused a schedule. Repeated refused or failed fires pause it; skipped ones never count.
  - **`skipped-erasure`:** a fire whose person is being erased is recorded as `skipped-erasure` (the run start answered `erasure-in-progress`), so an erasure that waits on a shared flow can't pause an hourly schedule.
  - **New routes:**
    - `GET …/{id}?upcoming=N` shows the next occurrences;
    - `GET …/{id}/fires` is the fire history;
    - `POST …/{id}/run-now` fires it now, `manual: true`;
    - `POST …/{id}/owner` lets an admin take a schedule over.
  - **Authorization,** with an authorizer:
    - `read` on the schedule's project to read;
    - `write` to change;
    - `admin` to take ownership;
    - registering or retargeting also needs `execute` on what it runs.
  - **Kind check:** pause, resume, unregister and the new routes answer 404 for another kind's trigger.
  - **Fixed:** registering a schedule or an event trigger refused every body (`config.cronExpression is required`).
  - **`createApp({ triggerKinds })`** mounts only the kinds a deployment fires.
  - **The binding:** `TriggerRegistryBinding` gains optional `listFires`, `fireNow` and `setOwner`, and a schedule's record has a `target` (agent or flow). `@kindgi/testing` has `createInMemoryTriggerRegistry`.
  
  **Clients and CLI:**
  - **TS:** `schedules.get(id, { upcoming })`, `fires`, `runNow`, `takeOwnership`.
  - **Python:** `fires`, `run_now`, `take_ownership`.
  - **CLI:** `kindgi schedules list|get|create|update|pause|resume|run-now|fires|take-ownership|unregister`.
- Updated dependencies [0919fe6]
- Updated dependencies [9801f25]
- Updated dependencies [490d083]
- Updated dependencies [cb20b9a]
- Updated dependencies [f19bc64]
- Updated dependencies [ede39f3]
- Updated dependencies [93ea565]
- Updated dependencies [a211c34]
- Updated dependencies [37734c5]
- Updated dependencies [3fbb4ee]
- Updated dependencies [b67c599]
- Updated dependencies [e27d050]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [1633db1]
- Updated dependencies [b67c599]
- Updated dependencies [93ebe85]
- Updated dependencies [b67c599]
- Updated dependencies [d94a98c]
- Updated dependencies [88953c7]
- Updated dependencies [fa77071]
- Updated dependencies [704dd29]
- Updated dependencies [70c5737]
- Updated dependencies [b67c599]
- Updated dependencies [eff6249]
- Updated dependencies [0fe157e]
- Updated dependencies [18576cf]
- Updated dependencies [70c5737]
- Updated dependencies [81f46aa]
- Updated dependencies [e99a7aa]
- Updated dependencies [a1f3dd1]
- Updated dependencies [d25c1b3]
- Updated dependencies [1a1f5ca]
- Updated dependencies [d7d5c45]
- Updated dependencies [94c999f]
- Updated dependencies [2799295]
- Updated dependencies [976801d]
- Updated dependencies [966425e]
- Updated dependencies [646a906]
- Updated dependencies [cbb6785]
- Updated dependencies [66bab49]
- Updated dependencies [6dc2637]
- Updated dependencies [e34e3bc]
- Updated dependencies [b67c599]
- Updated dependencies [7a85bf6]
- Updated dependencies [423aeea]
  - @kindgi/api@0.1.5-rc.0

## 0.1.4

### Patch Changes

- 71412f6: With authorization enforced, every membership change keeps the authorization store in step. `TenantHierarchyBinding` gains optional `removeTeamMember`, `updateTeamMemberRole`, `removeProjectMember` and `updateProjectMemberRole`, which change the membership row and its authorization tuple together. With an authorizer wired, `DELETE` and `PATCH /v1/{teams,projects}/{id}/memberships/{userId}` go through them. A binding without them is refused with `501 authz-membership-unsupported`, and nothing is changed. Without an authorizer, the membership bindings are used, as before.
  
  With authorization enforced, registering or unregistering an approval reviewer (`POST /v1/approvals/reviewers`, `POST /v1/approvals/reviewers/{id}/unregister`) needs `admin` on the tenant. Reading the roster doesn't.
- Updated dependencies [1c0252c]
- Updated dependencies [1c0252c]
- Updated dependencies [b9d3c01]
- Updated dependencies [ee0b6d5]
- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [0b1f48d]
- Updated dependencies [2b34f78]
- Updated dependencies [9a7f43b]
- Updated dependencies [6260a59]
- Updated dependencies [0359caf]
- Updated dependencies [29fbd56]
- Updated dependencies [fcc6a97]
- Updated dependencies [d0ebeb6]
- Updated dependencies [86ec2ef]
- Updated dependencies [e97958c]
- Updated dependencies [a311b81]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [e2ab2ac]
- Updated dependencies [fac7472]
- Updated dependencies [f999acd]
- Updated dependencies [52c8f98]
- Updated dependencies [d3dffb5]
- Updated dependencies [7528aca]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [b8ff156]
- Updated dependencies [e58e35c]
- Updated dependencies [5608264]
- Updated dependencies [7a8e764]
- Updated dependencies [8491dd8]
- Updated dependencies [a0921a1]
- Updated dependencies [d9cee7c]
- Updated dependencies [dde7fdb]
- Updated dependencies [933e00a]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [ba2f212]
- Updated dependencies [06b5fc0]
- Updated dependencies [e17b230]
- Updated dependencies [e7e2f86]
- Updated dependencies [3d23304]
- Updated dependencies [42a2e66]
- Updated dependencies [7155588]
- Updated dependencies [2923703]
- Updated dependencies [7471e05]
- Updated dependencies [bfeabfd]
- Updated dependencies [8861bf8]
- Updated dependencies [d0ebeb6]
- Updated dependencies [9801f64]
- Updated dependencies [dc5cfb1]
- Updated dependencies [a5560d7]
- Updated dependencies [e2ba026]
- Updated dependencies [1bec998]
- Updated dependencies [62608e3]
- Updated dependencies [3e427c5]
- Updated dependencies [376d9e4]
- Updated dependencies [f90c285]
- Updated dependencies [ffb6096]
- Updated dependencies [ae417f7]
  - @kindgi/api@0.1.4
  - @kindgi/agents@0.1.4
  - @kindgi/runtime@0.1.4
  - @kindgi/platform@0.1.4
  - @kindgi/memory@0.1.4

## 0.1.4-rc.5

### Patch Changes

- Updated dependencies [29fbd56]
- Updated dependencies [52c8f98]
- Updated dependencies [9801f64]
  - @kindgi/api@0.1.4-rc.5
  - @kindgi/runtime@0.1.4-rc.5
  - @kindgi/agents@0.1.4-rc.5
  - @kindgi/memory@0.1.4-rc.5
  - @kindgi/platform@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- Updated dependencies [f999acd]
- Updated dependencies [5608264]
  - @kindgi/agents@0.1.4-rc.4
  - @kindgi/api@0.1.4-rc.4
  - @kindgi/memory@0.1.4-rc.4
  - @kindgi/platform@0.1.4-rc.4
  - @kindgi/runtime@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- Updated dependencies [3e427c5]
  - @kindgi/api@0.1.4-rc.3
  - @kindgi/agents@0.1.4-rc.3
  - @kindgi/memory@0.1.4-rc.3
  - @kindgi/platform@0.1.4-rc.3
  - @kindgi/runtime@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- 71412f6: With authorization enforced, every membership change keeps the authorization store in step. `TenantHierarchyBinding` gains optional `removeTeamMember`, `updateTeamMemberRole`, `removeProjectMember` and `updateProjectMemberRole`, which change the membership row and its authorization tuple together. With an authorizer wired, `DELETE` and `PATCH /v1/{teams,projects}/{id}/memberships/{userId}` go through them. A binding without them is refused with `501 authz-membership-unsupported`, and nothing is changed. Without an authorizer, the membership bindings are used, as before.
  
  With authorization enforced, registering or unregistering an approval reviewer (`POST /v1/approvals/reviewers`, `POST /v1/approvals/reviewers/{id}/unregister`) needs `admin` on the tenant. Reading the roster doesn't.
- Updated dependencies [0b1f48d]
- Updated dependencies [2b34f78]
- Updated dependencies [9a7f43b]
- Updated dependencies [fcc6a97]
- Updated dependencies [86ec2ef]
- Updated dependencies [e97958c]
- Updated dependencies [e2ab2ac]
- Updated dependencies [7528aca]
- Updated dependencies [e58e35c]
- Updated dependencies [8491dd8]
- Updated dependencies [933e00a]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [ba2f212]
- Updated dependencies [e7e2f86]
- Updated dependencies [42a2e66]
- Updated dependencies [7155588]
- Updated dependencies [7471e05]
- Updated dependencies [dc5cfb1]
- Updated dependencies [e2ba026]
- Updated dependencies [1bec998]
- Updated dependencies [376d9e4]
- Updated dependencies [ffb6096]
- Updated dependencies [ae417f7]
  - @kindgi/api@0.1.4-rc.2
  - @kindgi/agents@0.1.4-rc.2
  - @kindgi/runtime@0.1.4-rc.2
  - @kindgi/platform@0.1.4-rc.2
  - @kindgi/memory@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- Updated dependencies [0359caf]
- Updated dependencies [b8ff156]
- Updated dependencies [06b5fc0]
- Updated dependencies [8861bf8]
- Updated dependencies [f90c285]
  - @kindgi/agents@0.1.4-rc.1
  - @kindgi/api@0.1.4-rc.1
  - @kindgi/runtime@0.1.4-rc.1
  - @kindgi/platform@0.1.4-rc.1
  - @kindgi/memory@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [6260a59]
- Updated dependencies [d0ebeb6]
- Updated dependencies [a311b81]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [fac7472]
- Updated dependencies [d3dffb5]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [7a8e764]
- Updated dependencies [a0921a1]
- Updated dependencies [d9cee7c]
- Updated dependencies [dde7fdb]
- Updated dependencies [e17b230]
- Updated dependencies [3d23304]
- Updated dependencies [2923703]
- Updated dependencies [bfeabfd]
- Updated dependencies [d0ebeb6]
- Updated dependencies [a5560d7]
- Updated dependencies [62608e3]
  - @kindgi/agents@0.1.4-rc.0
  - @kindgi/api@0.1.4-rc.0
  - @kindgi/platform@0.1.4-rc.0
  - @kindgi/runtime@0.1.4-rc.0
  - @kindgi/memory@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [2544717]
- Updated dependencies [0f226c2]
- Updated dependencies [629057d]
- Updated dependencies [786cbde]
- Updated dependencies [1463b77]
- Updated dependencies [aa4399f]
- Updated dependencies [453056f]
- Updated dependencies [6bae409]
- Updated dependencies [ab23a9b]
- Updated dependencies [6c274dd]
- Updated dependencies [2c185d8]
- Updated dependencies [eac7732]
  - @kindgi/agents@0.1.3
  - @kindgi/api@0.1.3
  - @kindgi/runtime@0.1.3
  - @kindgi/memory@0.1.3
  - @kindgi/platform@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
- Updated dependencies [610a9de]
- Updated dependencies [a994217]
  - @kindgi/agents@0.1.2
  - @kindgi/api@0.1.2
  - @kindgi/memory@0.1.2
  - @kindgi/platform@0.1.2
  - @kindgi/runtime@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [786ea98]
- Updated dependencies [324aba4]
  - @kindgi/api@0.1.1
  - @kindgi/agents@0.1.1
  - @kindgi/memory@0.1.1
  - @kindgi/platform@0.1.1
  - @kindgi/runtime@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/api@0.1.0
  - @kindgi/runtime@0.1.0
  - @kindgi/agents@0.1.0
  - @kindgi/memory@0.1.0
  - @kindgi/platform@0.1.0
