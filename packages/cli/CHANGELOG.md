# @kindgi/cli

## 0.1.4-rc.1

### Patch Changes

- 3694313: `kindgi projects list`, `kindgi projects get-default` and `kindgi projects get <project-id>`: find the project ids that `--project=<id>` takes (blocks, eval suites and runs, judge classes, agents derive), as the clients' `projects.list`, `getDefault` and `get` do.
- eec9748: `kindgi dev` runs runtime 0.1.4-rc.1.
- 0bfd27b: `kindgi dev` checks the runtime's port before it starts anything. When `4000` is taken (another `kindgi dev`, in another worktree say), it takes the next free port and says so; `.kindgirc.json` records the URL, so clients follow. A `--port` that's taken is refused at once: "port 4301 is in use. Pick another with --port, or stop what's using it." Before, the boot created the database and bundled the pack, then failed on Docker's "port is already allocated".
- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- c0f1b56: `KINDGI_PUBLIC_URL`: the URL clients reach the runtime at, when it isn't the address the server binds (behind a proxy, or a container whose port is published on another one). The runtime's startup banner names it, with its docs and console links. `kindgi dev` sets it, so the banner shows the port `kindgi dev` chose, e.g. 4001 when 4000 was taken, not the container's 4000. `parsePublicUrl` validates it; a runtime that doesn't read it keeps working.
- 8861bf8: **A registry that takes no writes says so: `409 registry-read-only`.** Under `kindgi dev` the pack's files are the source of agents, tools, flows and guardrails. Writing to them used to answer a misleading `already-registered` (for an agent, even naming a "next free version") or `not found`.
  
  - **The marker:** `AgentRegistryBinding`, `ToolRegistryBinding`, `FlowRegistryBinding` and `GuardrailRegistryBinding` take an optional `readOnly: { reason }` (`RegistryReadOnly`).
  - **What's refused:** every write to a registry that sets it, before the binding is called:
    - publish, unregister and reinstate;
    - deriving an agent version;
    - a deployment that would publish into it.
  - **The refusal:** `409 registry-read-only`, with the binding's reason as the message, e.g. "Under kindgi dev, the pack is the source of agents: edit the pack's file and kindgi dev reloads it." Reads are unchanged.
  - **Clients:** both read `registry-read-only` as a conflict, its code the reason.
  - **CLI:** an error line now shows a conflict's own code, so `kindgi agents publish` prints `Error [registry-read-only]: Under kindgi dev, …`.
- Updated dependencies [846dd9c]
- Updated dependencies [b8ff156]
- Updated dependencies [06b5fc0]
- Updated dependencies [c0f1b56]
- Updated dependencies [8861bf8]
- Updated dependencies [f90c285]
  - @kindgi/env-schema@0.1.4-rc.1
  - @kindgi/flow@0.1.4-rc.1
  - @kindgi/client@0.1.4-rc.1
  - @kindgi/platform@0.1.4-rc.1
  - @kindgi/sdk@0.1.4-rc.1
  - @kindgi/secrets-dotenv@0.1.4-rc.1
  - @kindgi/handler-runtime@0.1.4-rc.1
  - @kindgi/crypto@0.1.4-rc.1
  - @kindgi/dotenv-file@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- 6260a59: **`GET /v1/blocks` narrows by project or org like the other lists:** `?scopeKind=project&scopeId=<id>` or `?scopeKind=org&scopeId=<id>`, in place of `?projectId=`. A malformed scope answers `400 scope-invalid`.
  
  - `BlockListInput.scope` (a `Scope`) replaces `projectId`. A block store lists the blocks of the project, of every project in the org, or of the whole tenant.
  - TS: `client.blocks.list({ scope: { kind: 'project', projectId } })`.
  - Python: `client.blocks.list(scope_kind='project', scope_id=...)`.
  - `kindgi blocks list --project=<id>` is unchanged.
- 08341ff: `kindgi dev` runs runtime 0.1.4-rc.0.
- d0ebeb6: Comparison eval runs: an agent version run on a test set, beside the recorded runs.
  
  - **`@kindgi/api`:**
    - **Starting the run.** `POST /v1/eval-suites/{suiteId}/runs` on a `judged` suite (a test set) is a comparison. `agentRef` with its `version` is the candidate. The new body fields are `baseline` (default `'recorded'`), `reads` (`recorded` or `live`), `repetitions` (1–10) and `k` (1–100), and the run keeps them as `comparison`. Only `baseline: 'recorded'` runs today; `{ agentId, version }` and `{ live: … }` are accepted by the contract and refused when the run starts.
    - **The dispatcher.** `createJudgedDispatcher({ cases })` replays each case on the candidate. It goes through the subject invoker, with `replay: { of, evalRunId }` and the case's history, so the replay does nothing the past run didn't. It scores the candidate's output items against the judgments.
    - **Matching items.** A judgment carries over to the same item: the same own id, or, for the answer and elements without an id, the same content.
    - **The result.** `result.summary` (`JudgedComparisonSummary`) has:
      - the baseline (the versions behind the recorded runs) and the candidate;
      - `cases`, `diverged` (a read with no recording ran live), `refusedWrites` and `errors`;
      - the models that answered;
      - `metrics`: `weightedYesShare`, `judgedCoverage` and `weightedPrecisionAtK`, each with the baseline, candidate and delta and the evidence on both sides (`n`, `weight`, `baselineN`, `baselineWeight`), plus `k` and `spread`.
  
      `result.perCase` has each case's replay runs, the items kept, dropped and new, and its tool calls.
    - **Exports.** The item functions (`outputItems`, `matchJudged`, `scoreItems`, `itemChanges`) are exported. Test sets record the project their judgments came from (`spec.projectId`).
  - **`@kindgi/client`:** `evalRuns.start` takes the new fields, and the Python client does too.
  - **`@kindgi/cli`:** `kindgi eval-runs start | show | list | cancel`. `start` takes `--agent` with `--agent-version` (or `--flow`), `--baseline`, `--reads`, `--repetitions`, `--k`, `--dry-run` and `--wait`.
- a0652ac: **Data blocks: versioned prompts and settings an agent version will pin.** A block is published like a tool: immutable versions, soft unregister and reinstate. It belongs to one project.
  
  - **Kinds:**
    - `prompt`: a Liquid template with declared parameters, rendered as an agent's instructions are.
    - `settings`: a JSON object, optionally with a JSON Schema. Its values must satisfy it, and so must a later version's.
  - **`@kindgi/api` adds `/v1/blocks`:** list (latest of each; `kind`, `name`, `projectId` filters), get, versions (`includeTombstoned`), a version, publish, unregister and reinstate. It's mounted when `createApp` gets a `blockRegistry` (`BlockRegistryBinding`).
  - **Authorization goes through the block's project:** `read` to read, `write` to publish, unregister or reinstate. A block the caller can't read answers 404.
  - **Refusals:**
    - a block's kind never changes;
    - a block's versions stay in its first version's project (`409 block-project-mismatch`);
    - a taken version is `409 block-already-registered`.
  - **`@kindgi/agents` adds** `validateBlock()`, `settingsSchemaIssues()` and the block types.
  - **Clients:** `@kindgi/client` adds `client.blocks`, and the Python client has the same resource.
  - **`@kindgi/cli` adds** `kindgi blocks list | show | versions | publish | unregister | reinstate`. `publish` takes `--prompt=@<file>`, `--settings=<json>|@<file>` with `--schema`, or a full definition as JSON.
- fa6680c: **A deploy pins its agents and never keeps a version's old pins.** `POST /v1/deployments` pins each agent as `POST /v1/agents` does. A deploy registers an agent under the version its definition names. When that version is already registered with other pins or content (versions never change), the deploy registers the next free version in its line instead (`1.4.0` → `1.4.1`, `1.4.0-rc.1` → `1.4.0-rc.2`). A deploy never refuses a routine deploy over this.
  
  - **Why a new version:**
    - `pins-changed`: a tool the agent uses has a new version in range.
    - `unpinned`: the version was published before pins existed.
    - `version-taken`: the number is registered with another definition.
  - **Redeploys are idempotent.** A redeploy finds the version an earlier deploy registered for the same definition and pins.
  - **The record:**
    - The registered version records `derivedFrom: {version, reason}`.
    - The deployment's `contents.agents` names each agent's registered `version`. Where it differs from the definition's, it also gives `authoredVersion`, `reason`, `newVersion` and `pinChanges`.
  - **`kindgi deploy` prints one line per such agent:** `agent acme.matcher: registered new version 1.4.1 (1.4.0's pins changed: tool acme.score 1.0.0 → 1.1.0); set version: '1.4.1' in acme.matcher to match`.
  - **A range that matches no published version refuses the deploy:** `400 validation-failed`, with one issue per tool (`/agents/<i>/tools/<j>/version`), and the deploy's tools are rolled back.
  - **New exports:**
    - `@kindgi/agents`: `pinChanges()` and the `AgentDerivation` and `PinChange` types.
    - `@kindgi/tools`: `nextVersion()`.
- fac7472: **Derive an agent version with new data-block pins, with no code change.** An expert edits a prompt or settings block and publishes a new version of it; deriving an agent version is how that edit reaches the agent.
  
  - **`POST /v1/agents/{agentId}/versions`** `{ from, pins: { prompts?, settings? }, label?, projectId? }`:
    - The new version is `from` with the named pins swapped, everything else kept.
    - It's numbered the next free patch after the agent's highest version (versions never change).
    - It records `derivedFrom: { version, reason: 'edited', label?, by: 'user:<id>' }`.
    - Answers `201` with the new agent version.
    - Needs `publish` on the agent.
  - **Refusals** (`400 validation-failed`, naming each problem under `details.issues`):
    - a version published before pins;
    - a block the version doesn't already reference (adding one is a code change);
    - a block version that isn't published, is unregistered, is the wrong kind, or isn't model settings for the model-settings block;
    - swaps that change nothing.
    - Tool pins can't be swapped: they come from code.
    - An unknown version answers `404 agent-not-found`.
  - **Clients:**
    - TS: `client.agents.versions.derive(agentId, { from, pins, label })`.
    - Python: `client.agents.derive_version(agent_id, from_=..., pins=...)`.
    - CLI: `kindgi agents derive <agent-id> --from=<semver> --prompt=<block-id>=<version> --setting=<block-id>=<version> [--label=<text>]`. Repeat `--prompt` and `--setting` for several blocks.
  - **A taken number is never overwritten.** `POST /v1/agents` with a version that's already registered (a derived version may hold it) still answers `409 agent-already-registered`. It now names the next free version in the message and as `nextFreeVersion`: `… is already registered, and versions never change; publish it as 1.4.2, the next free version`.
  - **Deploys:** a deploy whose definition and pins match a derived version reuses it, reporting the deploy's own reason (`pins-changed`), not `edited`.
  - **`VersionDerivation`:** `reason` adds `'edited'`; new optional `label` and `by`.
- 5a64700: **`kindgi dev` names the `unregister` for every declared provider it leaves.** When a provider with a declared id is registered already, but not by `kindgi dev`, it is still left as it is. Each such line now names the `kindgi providers unregister <id>` that lets the config's version apply. Before, only a provider with another region or models got that hint (the ⚠ line). The runtime lists a provider's metadata, not its adapter, the adapter's settings or the key's name. So a provider registered by hand against another endpoint, with the config's models, looked the same and got no hint. The line now says those can't be compared.
- 49c5921: `kindgi dev` keeps track of the providers it registered from `kindgi.config.ts` across restarts of the bundled Postgres. Its record of them (`.kindgi/dev/providers.json`) was keyed on the database's host port, which changes when the bundled Postgres's container comes back. After that, those providers read as someone else's: a change to one in the config wasn't applied ("registered already, not from kindgi.config.ts; left as it is"), and one removed from the config stayed registered. The record is now keyed on the project's database for the bundled Postgres, and on the runtime's origin with `--runtime-url`; a database you pass with `--database-url` is keyed as before. A record written by 0.1.3 is taken over on the next boot.
- f4592c4: **`kindgi dev` stops at once when you press Ctrl+C (or send SIGTERM) while it waits for the runtime.**
  
  Before, the wait for the runtime never looked at the stop. That covers the wait at `--runtime-url` (up to 10 minutes) and the wait for the runtime container to start serving. A single Ctrl+C was then ignored until the wait ended, and only a second signal, or SIGKILL, stopped it.
  
  Now it stops at once, prints `kindgi dev stopped before the Kindgi runtime served.`, and exits with 130. A runtime container it was starting is removed right away, since it hadn't served anything. Stopping a running session is unchanged.
- b169c3f: **`kindgi dev` no longer misses an edit when the file system drops its event.**
  
  On macOS, `fs.watch` (FSEvents) can drop or delay events under load. On one busy machine, 18 of 40 edits got no event within 2 s. A Python pack's code edits could then go unseen until a restart, and so could:
  - an env file's changes;
  - a primitive file added or removed.
  
  The watchers now also scan what they watch (paths, mtimes and sizes) about once a second, so a missed event costs about a second. `fs.watch` stays the fast path.
  
  The scan skips what the watchers never count: dependencies, virtualenvs, build output, VCS and dot folders. On a large tree it scans less often, at most every 5 s. A pack with 2,000 Python files (and 50,000 skipped) costs about 2% of one core; a typical pack, 0.3%. TypeScript code edits were never affected: esbuild's watch polls.
- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
- 263afd1: **`kindgi init <pack-name>` pins the pnpm that installs the pack.** A new TypeScript pack that stands alone, with no `packageManager` field or lockfile in the folders above it, gets `"packageManager": "pnpm@<version>"` with the version `pnpm --version` gives in its folder. `kindgi build`'s image, CI and teammates then install with that same pnpm; pnpm 10+ switches to it on its own. A pnpm 12 image refuses a lockfile an older pnpm wrote when it has entries less than a day old, so a mismatch can break a build right after a release.
  
  Inside an existing project, nothing is written: that project's own setup governs. Adding Kindgi to an app and Python packs are unchanged. When pnpm's version can't be read, the next steps say so and how to set the field.
- a0921a1: Test sets built from judgments, and context captured when a run is first judged. `@kindgi/api` adds the `judged` eval kind, `POST /v1/eval-suites/{suiteId}/versions/from-judgments` (publishes a version whose cases are copies of an agent's or flow's judged runs, each item's judgments summed and weighted by judge class) and `GET /v1/eval-suites/{suiteId}/versions/{version}/cases`, mounted when `createApp` gets an `evalCaseStore` (`EvalCaseStoreBinding`) beside `evalSuiteRegistry` and `judgmentRegistry`; a `JudgmentRegistryBinding` adds `listJudgedRuns` to support it. The first judgment of an agent turn also stores `context` on the run copy: the conversation before the turn and what its retrievals returned. `@kindgi/client` adds `evalSuites.buildFromJudgments` and `evalSuites.listCases`; the Python client has the same methods. `@kindgi/cli` adds `kindgi eval-suites list | show | from-judgments | cases`.
- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- 8b2e3a3: A release candidate of the CLI keeps to its own release. Its hints run `npx --yes @kindgi/cli@<its exact version>`, since a `0.1`-style range never matches a pre-release and would run the last release. A Python pack it creates requires `kindgi>=<its version>,<…>` in PEP 440 (`kindgi>=0.1.4rc0,<0.2`), so pip and uv install the matching Python SDK, and the same requirement takes the release once it's out. A release CLI is unchanged.
- d0ebeb6: Replay turns: an agent turn can re-run a past run for an eval run without doing anything the past run didn't do.
  
  - `@kindgi/agents`:
    - `InvokeAgentInput.replay` (`{ of, evalRunId }`) marks a turn as a replay. It is kept on the turn's run and in its run snapshot (new nullable `agent_run_snapshots.replay` column), so a resumed turn stays a replay.
    - The new optional `InvokeAgentBindings.replay` (`ReplayBinding`) decides each tool call:
      - `live`: the tool runs;
      - `recorded`: the past run's result is used;
      - `refused`: the model gets the given result.
    - Whatever the binding says, only a tool declared read-only (`mutating: false`, no writing effect, see `isReadOnlyTool`) with no approval to wait for runs. A replay with no binding refuses every call.
    - Each decision is journaled, and `AgentTurnResult.replay` lists them. A refused call shows what the turn would have done.
    - `retrievals` can supply the past run's retrieved facts. `sessionApproval` gives the past run's decision at the session approval gate, which the replay follows (a recorded rejection fails the turn with `hitl-rejected`). Without a recorded decision the gate is skipped, and the result says so.
    - `tool.completed` events carry `replay: 'live' | 'recorded' | 'refused'`.
  - `@kindgi/runtime`: `RunReplayRef`; `replay` on `runGraph` and `startRun`; `replayOf` and `evalRunId` on `KernelRunRecord`; `replays` and `evalRunId` on `ListRunsInput`.
  - `@kindgi/capabilities`: `ModelUsageRecord.replay` tags a replay's model calls with the past run and the eval run.
  - `@kindgi/api`:
    - A run carries `replayOf` and `evalRunId`.
    - `GET /v1/runs` leaves replay runs out unless `replays=include|only`; `evalRunId` lists one eval run's replays.
    - A judged agent turn's captured `context` also keeps `sessionApproval`, the decision at its session approval gate.
  - `@kindgi/client`: `runs.list({ replays, evalRunId })`; the Python client too.
  - `@kindgi/cli`: `kindgi runs list --replays=<exclude|include|only> --eval-run=<id>`.
- eb60481: **When the runtime container stops while `kindgi dev` starts it, the message always says why.**
  - It names the container's exit code and what the code means: 137 killed or out of memory, 139 a crash, 126/127 a command that couldn't run. Docker's own error is included when there is one.
  - It gives the container's last log lines, read whole.
  - A container that stopped before printing anything is said to have done so. Before, the message could end with an empty reason.
  
  The container no longer runs with `--rm`, so a fast exit's logs and exit state can still be read; `kindgi dev` removes it itself, when it stops and after a failed start. `docker logs`' own errors (such as "can not get logs from container which is dead…") are no longer shown as the runtime's output.
- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [6260a59]
- Updated dependencies [d0ebeb6]
- Updated dependencies [a311b81]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [fac7472]
- Updated dependencies [e197294]
- Updated dependencies [d3dffb5]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [7a8e764]
- Updated dependencies [a0921a1]
- Updated dependencies [dde7fdb]
- Updated dependencies [e17b230]
- Updated dependencies [b52d890]
- Updated dependencies [3d23304]
- Updated dependencies [2923703]
- Updated dependencies [bfeabfd]
- Updated dependencies [d0ebeb6]
- Updated dependencies [62608e3]
  - @kindgi/client@0.1.4-rc.0
  - @kindgi/handler-runtime@0.1.4-rc.0
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/platform@0.1.4-rc.0
  - @kindgi/sdk@0.1.4-rc.0
  - @kindgi/secrets-dotenv@0.1.4-rc.0
  - @kindgi/crypto@0.1.4-rc.0
  - @kindgi/dotenv-file@0.1.4-rc.0
  - @kindgi/env-schema@0.1.4-rc.0

## 0.1.3

### Patch Changes

- **`kindgi build` installs with the pnpm that wrote the lockfile.** For a pnpm pack whose `package.json` has no `packageManager`, the image used to take the newest pnpm through corepack. pnpm 12 refuses packages published less than a day ago (`minimumReleaseAge`) when it installs from a lockfile an older pnpm wrote. So, for anyone on pnpm 10 or 11, a build failed for a day after any of the pack's dependencies was released, a new Kindgi version included, and the image's pnpm changed with every pnpm release. The image now installs the host's pnpm version, the one `pnpm --version` gives in the install root. When that can't be read, `kindgi build` refuses and says to add `packageManager`. A `packageManager` in `package.json` still wins, and pnpm's own policies are left as they are.
- ddea933: `kindgi dev` gives each project its own database in the bundled Postgres, `kindgi_<project>`, with its own dev tenant and user. A linked git worktree gets `kindgi_<project>__<worktree>`, so branches on different Kindgi versions never share a schema.
  
  - **The project's name:** `project` in the Kindgi config (`kindgi.config.ts`, or `project` under `[tool.kindgi]` in `pyproject.toml`), else the git repository's, the workspace root's or the pack folder's. The boot log names it.
  - **A database belongs to the folder that made it:** another folder whose project has the same name is refused until it sets its own `project`. A moved folder takes its database with it.
  - **`--reset` drops the project's database** after asking. `--yes` skips the question, and with no terminal to ask on it refuses. A database passed with `--database-url` is never dropped.
  - **Shared:** every pack of one project shares the database and the tenant. Each keeps its own tools, pack service and env files.
  - **The shared `kindgi` database** earlier releases used is left as it is. The first boot says so, once.
- d4dcbd7: **`kindgi dev` registers the model providers the config declares.** List them as `providers` in `kindgi.config.ts`, or as `[[tool.kindgi.providers]]` tables in `pyproject.toml`. Each one is a preset (`{ preset: 'gemini', project: 'acme-gcp', models: [...] }`, the choices `providers register --preset` takes) or a `{ spec: … }` registration body. They are then registered in every worktree's database, after `--reset`, and on a teammate's machine, with no `providers register` to repeat.
  
  On each boot, `kindgi dev` keeps the runtime in step with the list:
  - it registers a missing provider;
  - it re-registers one it registered whose declaration changed;
  - it unregisters one the config no longer declares.
  
  It leaves alone any provider it didn't register. One registered differently gets a warning naming the `unregister` that lets the config's version apply. A provider whose key isn't in the env files is skipped, with one line naming the secret.
  
  A key is always a secret's name: a `spec` with a credential in `adapter_config` is refused. Which providers `kindgi dev` registered is recorded in `.kindgi/dev/providers.json`, per database and tenant.
- fceb277: `kindgi dev` no longer misses a save that lands while a rebuild is running. The bundler skipped a rebuild that read the same files as the last one it reported, and told them apart by each file's size and modification time, read once the build had ended. A file saved during a build (an editor's save landing mid-build, or one caught half written, as when watching starts) was read before the save but stamped after it, so the rebuild the save triggered looked unchanged and was dropped: the dev index stayed on the stale build, a half-written file's "refresh failed" included, until the next save. A build during which an input changed (or changed within 3 s of its start, too close to tell) is now never taken for a later one.
  
  The pack conformance fixture has a new tool, `conformance.hold`: it prints `hold: <release>` on stdout and waits until the file `release` exists. The suite's drain, concurrency-cap and disconnect cases hold a call open with it, so each acts once the service has taken the call, and for exactly as long as it needs, rather than after a fixed wait. A pack service in another language implements it in its fixture pack (see `FIXTURE.md`).
- 4ed3d2f: CLI fixes from a pilot's feedback, and the runtime's port order.
  
  - **`kindgi runs start` never loses the run.** It starts the run in the background and follows it, rather than holding the start request open. A long agent turn no longer times out the CLI with no run id to look it up by. It still waits until the run finishes or waits on an approval, and prints the same record. A stopped wait (Ctrl+C) prints `Stopped waiting. Run <id> goes on: kindgi runs get <id>`.
  - **The Gemini preset uses the models' real output limit:** 65,536 tokens for Gemini 2.5 Pro and Flash, thinking included. It used to cap Pro at 8192. `kindgi providers register --preset=<name> --max-output-tokens=<n>` sets another cap.
  - **`kindgi env plan --format=gcloud` emits `--update-env-vars` / `--update-secrets`.** They add or replace the names listed and leave the service's other variables alone. `--set-*` replaced the whole env.
  - **`KINDGI_API_PORT`'s description states the port order.** The runtime takes the first that's set: the `--port` flag, `KINDGI_API_PORT`, the platform's `PORT` (Cloud Run, Render, Heroku and Fly set it), the config file's `port`, then 4000.
- 2c185d8: Fixes from the first Cloud Run deployment.
  
  - **The pack service token is read the same way on both sides.** `parsePackServiceToken` (new in `@kindgi/env-schema`) drops surrounding whitespace, so a secret stored with a trailing newline no longer makes every pack call answer 401. A token with whitespace or a control character inside is refused at startup, since an HTTP header can't carry it. The Node pack service and the Python one (`kindgi.pack.serve`) both use the rule, and the pack conformance suite checks it.
  - **Refusals aren't replayed.** The idempotency middleware stores a response only when the request took effect (a status below 400). A request retried with the same `Idempotency-Key` after a refusal (4xx) or a failure (5xx) runs again, so a deploy retried after trusting its key now goes through.
  - **`kindgi deploy` says when an answer is a replay** (`X-Idempotent-Replay`) and how to retry: `--idempotency-key <new value>` for a replayed refusal from an older runtime. A refused signing key's hint gives the `kindgi key trust <keyId> --url <endpoint>` command on a line of its own. The retry advice for server errors and network failures is reworded.
- 024582b: The getting-started and providers skills, and the templates' AGENTS.md, teach declaring model providers in the pack's config (`providers` in `kindgi.config.ts`, `[[tool.kindgi.providers]]` in `pyproject.toml`), which `kindgi dev` registers on every boot. The providers skill's Gemini example has the models' real output limit, 65,536 tokens.
- Updated dependencies [2544717]
- Updated dependencies [629057d]
- Updated dependencies [38935d3]
- Updated dependencies [1463b77]
- Updated dependencies [453056f]
- Updated dependencies [6bae409]
- Updated dependencies [ab23a9b]
- Updated dependencies [4ed3d2f]
- Updated dependencies [2c185d8]
- Updated dependencies [66e7ac2]
  - @kindgi/client@0.1.3
  - @kindgi/handler-runtime@0.1.3
  - @kindgi/types@0.1.3
  - @kindgi/env-schema@0.1.3
  - @kindgi/sdk@0.1.3
  - @kindgi/secrets-dotenv@0.1.3
  - @kindgi/crypto@0.1.3
  - @kindgi/platform@0.1.3
  - @kindgi/dotenv-file@0.1.3

## 0.1.2

### Patch Changes

- 9dbb491: `kindgi build --local` builds Python packs. It refused them ("build a Python pack with the build service"), and a self-hosted runtime has no build service, so a Python pack couldn't be deployed to one. A Python pack's image now builds with this machine's Docker from the same Containerfile and context as the build service's (its lockfile, frozen; the indexer stage's `/app/index.json` byte-identical to the local index), behind the same integrity gate; with `--push` it's pushed, signed, and written into the envelope for `kindgi deploy`. A Python pack's build context is now written as a directory and tarred the way a TypeScript pack's is, so the build service gets the same bytes as before.
- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- c84139c: `kindgi key trust <keyId>` adds a local key's public key to the runtime's trust list in one step, and `kindgi key revoke <keyId> [--reason]` removes it. Trusting no longer takes a shell pipeline: the runtime wants the 32 raw bytes, which `trust` sends, not the SPKI form `kindgi key export --format=base64` prints (unchanged). A refusal because the id is bound to another key, or was revoked, says to trust a key under a new id.
- Updated dependencies [966a615]
- Updated dependencies [fde369b]
- Updated dependencies [afd259f]
- Updated dependencies [80210cb]
- Updated dependencies [5c9594b]
- Updated dependencies [da1a8da]
  - @kindgi/client@0.1.2
  - @kindgi/crypto@0.1.2
  - @kindgi/dotenv-file@0.1.2
  - @kindgi/env-schema@0.1.2
  - @kindgi/handler-runtime@0.1.2
  - @kindgi/platform@0.1.2
  - @kindgi/sdk@0.1.2
  - @kindgi/secrets-dotenv@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- 799aaaa: **`kindgi auth registry` logs Docker in to the runtime image's registry.** The Kindgi runtime image `kindgi dev` runs is in private preview. With the pull credentials you receive, `kindgi auth registry --username <robot name>` asks for the token without echoing it (or reads it from stdin with `--password-stdin`), runs `docker login` with the token on its stdin, then checks that Docker can pull the exact image this CLI runs (with `docker buildx imagetools inspect`, or `docker manifest inspect` by digest where buildx isn't installed). Kindgi stores nothing: the credential lives in Docker's own credential store. `--check` only checks access, and a failure says whether it's access (request it at contact@kindgi.com) or the image or the network. When a pull is refused, `kindgi dev` now points to `kindgi auth registry`.
  
  **Ctrl+C at a hidden prompt cancels.** At the value prompt of `kindgi secrets set` and `rotate`, Ctrl+C (or Ctrl+D) ended the CLI silently with exit code 0. It now prints `Cancelled.` and exits 1, like the other prompts.
- a3070fa: Fixes for adding Kindgi to an existing app, and for `kindgi dev` output:
  - **`pnpm install` works right after `kindgi init`** in a pnpm app. pnpm 11+ stopped the first install with `ERR_PNPM_IGNORED_BUILDS` for esbuild, which `@kindgi/cli` uses to bundle the pack. `init` now records a decision for esbuild's install script, `allowBuilds.esbuild: false`, in the `pnpm-workspace.yaml` pnpm reads (the workspace root's, or a new one in the app). esbuild works without the script: its native binary comes from its `@esbuild/<platform>` package. `init` keeps the file's other keys and comments, replaces pnpm's `set this to true or false` placeholder, and keeps a decision the app already has (`true` or `false`). New packs' templates also switch from `true` to `false`.
  - **`init` adds `zod`** (`^4.0.0`, the new-pack range) to an existing app, since every tool's schemas use it. An app's own zod is kept; if it is older than zod 4, `init` says so.
  - **Ctrl+C on `kindgi dev` prints one line**, `Stopping kindgi dev... stopped.`, not the startup banner and a JSON summary. The JSON summary now goes to stdout only with `--json` or `--raw`, and reports an empty pack as `ok`, not as an indexer error.
  - **An empty pack says so at startup.** The startup output says there are no primitives yet and where to add the first one, and shows an indexer error at startup instead of at exit.
  - **`--table` works** for `runs list`, `tools list` and `providers list`. When there is a next page, its `--cursor` goes to stderr.
  - **The sample pack type-checks under pnpm.** `tsc --noEmit` failed with TS2742 on the sample guardrail. Its inline check is now typed with `DefinedCheck` from `@kindgi/sdk/define`.
- ca66617: `kindgi runs start --no-wait` describes what it does: an agent run returns as soon as it exists, like a flow run (follow it with `kindgi runs stream` or `kindgi runs get`). The `--path` help of `kindgi dev` and `kindgi test` names `kindgi.config.mts` too.
- e184714: **A new pack gets its `.gitignore` again.** `npx @kindgi/cli init` wrote no `.gitignore`: npm renames a package's `.gitignore` to `.npmignore` when it installs it, so the templates' file never reached the new pack, and `.env` (model keys) and `.kindgirc.json` (the dev token) weren't ignored by git. The templates now store it as `gitignore`, and `init` writes it as `.gitignore`. If you created a pack with 0.1.0, add a `.gitignore` with at least `.env`, `.env.local`, `.kindgirc.json` and `.kindgi/`. Adding Kindgi to an existing app was not affected.
- 811d030: **`kindgi dev` starts its Postgres without `docker compose`.** On a Docker engine without the compose plugin (common on a bare Linux engine), `kindgi dev` no longer stops and asks for `KINDGI_DATABASE_URL`: it starts the bundled Postgres with plain `docker`, and says so (`Postgres: started with docker (docker compose isn't available)`).
  - **The same Postgres either way:** the image, settings, healthcheck and random host port the bundled compose file defines, and the same container (`kindgi-dev_postgres`), volume (`kindgi-dev_postgres-data`) and network (`kindgi-dev`), so the data is shared whichever way it was started. What plain `docker` creates carries the `kindgi-dev` compose project's labels, so once compose is installed, `kindgi dev` and `docker compose -p kindgi-dev down -v` take it as their own.
  - **An existing container is reused as it is**, started if it's stopped, never recreated or removed. `--recreate-services` needs compose: without it, `kindgi dev` says the container was reused and how to recreate it by hand. `--reset` behaves as before: it starts one pack fresh and leaves the shared Postgres alone.
  - **The bundled Postgres listens on `127.0.0.1` only** (a random port), in both ways of starting it: its password is a fixed dev one, so it must not be reachable from the LAN. The runtime container still reaches it, through `host.docker.internal` on Docker Desktop and directly with Linux host networking. A `kindgi-dev_postgres` an earlier CLI started keeps its old binding (every address) until it's recreated: `kindgi dev --recreate-services` with compose, or `docker rm -f kindgi-dev_postgres` without it (the data stays in its volume), then `kindgi dev`.
  - **Without Docker,** the error names the two options: install Docker, or pass `--database-url` (or set `KINDGI_DATABASE_URL`) for your own Postgres 16 with pgvector.
- 3699f29: **`kindgi dev` warns about an import `kindgi build` would refuse:** a package the pack imports that `package.json` lists only in `devDependencies`. It loads on your machine, but a deployed pack installs production dependencies only, so it's missing there. The warning names the package and the files importing it, at startup and when a save adds one, once per package; after you move it to `dependencies`, the next reload says it's resolved. It checks what a pack image would load from `node_modules`, including what `kindgi.config.ts` imports. `--json` and `--raw` list them as `devOnlyImports`. Python packs aren't checked.
- faf19ec: A pack image never runs the app's own install scripts.
  
  - **The bug:** `kindgi build` installs the app's dependencies with scripts off, then rebuilds so the dependencies the app allows can build. The rebuild also ran the app's own pending scripts: pnpm and npm treat the project itself as pending. So a `postinstall: prisma generate` or a `prepare: husky` ran in the image and failed the build, since the image holds no schema and no `.git`.
  - **The fix:** the build context's copies of the app's project manifests (the root's, each workspace member's, the pack's) leave out their install lifecycle scripts: `preinstall`, `install`, `postinstall`, `prepare` and its pre/post, `prepublish`, `dependencies`. Every other field and script stays. The lockfile, the dependencies' own scripts and the allowlist are untouched. What the image needs from such a script comes from a build extension: `prisma()` runs `prisma generate`.
  - **`kindgi build` says what it left out:** "The app's own install scripts don't run in the image: postinstall (`prisma generate`), prepare (`husky`)".
  - **A skipped script that runs `patch-package` gets a warning:** its patches wouldn't be applied in the image. To apply them, add a build step: `defineBuildExtension({ name: 'patch-package', contextFiles: [<the patch files>], postInstall: [{ bin: 'patch-package' }] })`. Or, with pnpm, use `pnpm patch`, which the install applies itself.
- 319a134: A pack module that wouldn't load in the image now fails the build, saying why, not as a vague integrity-gate mismatch later.
  
  - **`@kindgi/cli`:**
    - `kindgi build` refuses a pack that imports a package its project lists only in `devDependencies`, before the image is built. The image keeps production dependencies only, so such an import loads locally but not in the image. The message names the package and says to move it to `dependencies`.
    - A Node pack's local index fails the build on file errors (a module that throws on import), as a Python pack's already did.
    - The image's indexer stage runs `kindgi-index --strict`.
  - **`@kindgi/handler-runtime`:** `kindgi-index --strict` exits 1 when a module fails to load, printing each file error. Before, the index was written without that module, and only the CLI's integrity gate noticed: "indexHash mismatch".
- 324aba4: **`POST /v1/runs/{runId}/resume` is not available in this release.** It now answers `422 run-resume-not-supported` and completes nothing. Every waitpoint a run can wait at belongs to an approval or to the runtime itself. A run waiting for an approval continues when a reviewer decides it, through `POST /v1/approvals/{approvalId}/complete` (`kindgi approvals complete`), which checks the reviewer and records the decision. `kindgi runs resume` says the same and is left out of `--help`.
- Updated dependencies [0fe5626]
- Updated dependencies [5ef3129]
- Updated dependencies [319a134]
- Updated dependencies [d00fc1b]
- Updated dependencies [d28e1fd]
- Updated dependencies [ca66617]
- Updated dependencies [bbe0bc9]
  - @kindgi/sdk@0.1.1
  - @kindgi/handler-runtime@0.1.1
  - @kindgi/env-schema@0.1.1
  - @kindgi/secrets-dotenv@0.1.1
  - @kindgi/client@0.1.1
  - @kindgi/crypto@0.1.1
  - @kindgi/dotenv-file@0.1.1
  - @kindgi/platform@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Minor Changes

- aec851d: `kindgi build --local --push [<repository>]` publishes from your machine:
  - **builds** for the deployment's platform: `linux/amd64` by default, as Cloud Run runs; `--platform` overrides it;
  - **pushes** to the repository: `--push`'s value, else `environments.<env>.registry` + `/<packId>`;
  - **checks** the pushed image's index against the local one, by digest;
  - **signs** as the build service path does, and writes `deploy-envelope.json` for `kindgi deploy`.
  
  It uses your own Docker credentials for the registry; Kindgi holds none. A command-line option can now take an optional value (`--push`, or `--push=<repository>`).
- aec851d: `describeCommands()` and `describeGlobalFlags()`: the CLI described as data (every command with its usage, its flags and its subcommands, and the global flags), with no handlers. The CLI reference on the documentation site is generated from them.
- aec851d: `@kindgi/cli`, the `kindgi` command, now lives in this repository: create a pack (`kindgi init`), run it on your machine against the Kindgi runtime image (`kindgi dev`), build, sign and deploy it, and work with a running Kindgi API from the terminal. It depends only on `@kindgi/*` packages and joins the fixed version group. The README is rewritten for how the CLI works today.
- aec851d: Build extensions for a TypeScript pack image: `image` in `kindgi.config.*`, with `@kindgi/sdk/build`.
  
  ```ts
  import { prisma } from '@kindgi/sdk/build';
  
  export default {
    pack: { id: 'acme.app', version: '1.0.0' },
    image: {
      systemPackages: ['tesseract-ocr'],
      extensions: [prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })],
      buildEnv: { DATABASE_URL: 'postgresql://build-placeholder' },
    },
  };
  ```
  
  - **`@kindgi/handler-runtime/build-extensions`**, re-exported as **`@kindgi/sdk/build`**:
    - `ImageConfig` and `BuildExtension` (`contextFiles`, `systemPackages`, `postInstall` steps, `buildEnv`);
    - `prisma({ schema, config? })`: copies the schema in and runs `prisma generate` after the install, before the prune. An app's `postinstall` doesn't run in the image;
    - `defineBuildExtension()`.
  - **`kindgi build`** reads and checks `image`, naming any field that's wrong, then renders it:
    - system packages in the base stage;
    - `buildEnv` in the install stage only, never the final image;
    - each step after the install, through the app's package manager (`pnpm exec`, `npx --no`, `yarn`).
- aec851d: A TypeScript pack image that works: it runs the pack's bundles, installs the app the way the app does, and `kindgi build --local` builds it with this machine's Docker.
  
  `@kindgi/handler-runtime`:
  - `runIndexer({ bundleMap, moduleRoot })` indexes a build. The map's source paths are the file list, classified by the discovery patterns, so the source tree needn't be there. Each file is imported from its bundle, and the index records the source path. `kindgi-index` takes `--bundle-map` and `--module-root`.
  - `kindgi-index-main`: the indexer as a process entry. Before, the image's indexer stage loaded `kindgi-index` and exited without writing an index.
  - The pack service's `--bundle-map`: the modules the index names load from their bundles.
  
  `@kindgi/cli`, `kindgi build`:
  - **Bundles:**
    - the pack's code is bundled, and its installed dependencies stay external, imported by name from the image's `node_modules`;
    - the indexer and the pack service are self-contained bundles;
    - every bundle is `.mjs` with sourcemaps, plus `dist/bundle-map.json` and the bundled `kindgi.config`;
    - the local index runs the same bundled indexer over the same bundles as the image, so the integrity gate compares like with like.
  - **Install:** the app's own package manager from its own lockfile, frozen with scripts off, then the build scripts the app allows, then a prune to production. pnpm and yarn come through corepack and the `packageManager` field. A pack in a workspace member sits at its own path.
    - `.npmrc` and `.yarnrc*` are build secrets, never in the context.
    - A dependency linked from outside the project is refused, with what to do instead.
    - The synthesized `package.json` is gone.
  - **Base image:** `node:22` or `node:24-bookworm-slim`, pinned by image index digest, picked from `engines.node` (`scripts/refresh-node-digests.mjs`).
  - **The Containerfile:** tini, `USER node`, `HEALTHCHECK`, `EXPOSE 8080`, `NODE_ENV=production`.
  - **The context:** the install's files, the bundles and `bundle.include`. The pack's source never ships.
  - **`--local`:** `docker buildx build --load` into the local image store as `kindgi-pack/<packId>:<artifactVersion>`, with the same integrity gate. No build service, no signing.

### Patch Changes

- 5fdc80b: Every flag says what it does: `kindgi <command> --help` lists the command's flags with a description, the global flags in `kindgi --help` come from the same definitions, and `describeCommands()` / `describeGlobalFlags()` carry the descriptions (the docs' CLI reference shows them). The help's config precedence now names `.kindgirc.json`. The README's `--template` row matches the templates (`minimal` is the folders, no examples).
- aec851d: Launch fixes:
  - **Unwired commands are hidden.** The commands this release doesn't wire (memory, artifacts, provenance, proposals, observations, tokens, capabilities, conversations, flows, and agents list/get/unregister/versions, tools publish) no longer appear in `--help` or the generated reference. Calling one still says it's not wired yet.
  - **`env list --reveal`** refuses unless stdout, where the values go, is a terminal. Before, `--reveal > file` typed in a terminal wrote the values unredacted.
  - **`auth whoami`** checks the token on an authenticated route (`/v1/identity/whoami`) and shows the identity. A wrong token now fails.
  - **`secrets`:** a version conflict suggests `--write-mode=add-version`; `--limit` and `--if-version` must be integers; no internal wording in the missing `--scope` error.
  - The `kindgi dev` banner's feedback hint uses `--body-stdin`, so a coding agent running it doesn't wait on `$EDITOR`.
  - The README matches: published packages, the private-preview runtime image, and only the wired commands.
- 56e3453: A Python pack has no npm project to install the CLI into, so its hints (`init`'s next steps, the `kindgi dev` banner, `providers`' secret hint) and the `.mcp.json` entries `kindgi mcp add` writes now run the published CLI through npx, within the running CLI's minor: `npx --yes @kindgi/cli@0.1 <command>`. Before, they said `kindgi …`, which fails without a global install. Node 22 is needed.
- be597c4: `kindgi dev` runs the Kindgi runtime 0.1.0 by default, pinned by digest (`quay.io/kindgi/runtime:0.1.0@sha256:…`). Docker doesn't re-pull a tag it already has, so a tag could leave you on an older runtime. When the pull is refused, the message says the image is in private preview and how to request access.
- aec851d: `kindgi --version` and `kindgi version` report the versions in the CLI's and the SDK's `package.json` (as `kindgi init` already did), not a constant that read `0.0.0`.
- aec851d: `kindgi build`, a pack image's install:
  - **Overrides' tarballs ship:** a `file:`/`link:` target that pnpm `overrides` (in `pnpm-workspace.yaml` or `package.json`), npm's nested `overrides`, or yarn's `resolutions` point at is in the build context. Before, a vendored package only an override named was missing in the image, and the install failed. One outside the project is refused, with what to do instead.
  - **Only the pack's project, in a pnpm workspace:** the image installs `--filter '{./<pack>}...'` (the pack's project and what it depends on), and prunes with the same filtered install plus `--prod`. `pnpm prune` ignores a filter and installs the whole workspace. npm and yarn still install the whole workspace.
  - **pnpm's metadata cache** is a BuildKit cache mount too, and `~/.cache` belongs to `node`. Otherwise corepack can't write its own cache beside the mount.
- aec851d: A pnpm pack image's rebuild reuses the packages it already downloaded.
  
  - **The bug:** the install stage's pnpm store was never the cache mount. BuildKit creates a mount's parent folders as root, so pnpm skipped `~/.local/share/pnpm` and kept its store in the layer. Every rebuild with a changed lockfile downloaded everything again.
  - **The fix:** the store is a cache mount at `/home/node/.cache/pnpm-store`, under the `~/.cache` the stage gives `node`. The stage names it for pnpm explicitly (`pnpm_config_store_dir` for pnpm 11, `npm_config_store_dir` before it), in the install stage only.
- aec851d: The Python SDK, `kindgi`, publishes to PyPI with the npm packages, at `0.1.0`.
  
  - **`kindgi init` for a Python pack, from a published CLI**, writes `kindgi` from PyPI within the CLI's own minor: `kindgi>=0.1,<0.2` for a 0.1 CLI. That covers the new template, an existing app's `pyproject.toml`, and the install line it prints, quoted for the shell. A CLI run from a Kindgi checkout keeps using the checkout's `sdks/python`.
  - **`check:publish`** fails when `sdks/python` and the npm packages don't share a major.minor.
  - **`release.yml`** publishes `kindgi` to PyPI on the same dispatch, in its own `pypi-publish` environment, with trusted publishing and attestations. A version PyPI already has is skipped.
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
- Updated dependencies [1f81d37]
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
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/client@0.1.0
  - @kindgi/sdk@0.1.0
  - @kindgi/env-schema@0.1.0
  - @kindgi/types@0.1.0
  - @kindgi/handler-runtime@0.1.0
  - @kindgi/dotenv-file@0.1.0
  - @kindgi/secrets-dotenv@0.1.0
  - @kindgi/crypto@0.1.0
  - @kindgi/platform@0.1.0
