---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/compliance": patch
"@kindgi/specs": patch
---

**A suggested change is made for one project, and checked on that project's test set.** This is a breaking change.

- **Making one.** `POST /v1/suggested-changes` takes `agentId`, `projectId`, `block`, then `values` (a settings block) or `template` (a prompt block), `why` and `fixes`. `fromVersion`, `scope`, `tier`, `change` and `evidence` are gone from the body.
  - It's built on the version the project runs. Its block version and agent version are published, and serve nothing until it's pinned.
  - Its check starts at once: the answer is `201`, with status `checking`.
  - The same change on the same version for the same project returns the one made before, with `X-Suggested-Change-Deduped`.
  - In a later environment of an environment order it's refused (`409 environment-takes-promotions`). Make it in the order's first environment: the new version reaches later environments when a build is promoted.
  - A read-only agent registry refuses making or checking one (`409 registry-read-only`), before anything else. Under `kindgi dev`, for example, the pack's files serve every project.
- **Its check.** Its version (`with`) and the version it's built on (`now`) run the same cases of the project's test set. The set is frozen when the check starts.
  - `POST /v1/suggested-changes/{suggestedChangeId}/check` checks it again, so new corrections count.
  - `check` replaces `evaluate` and `rescore`, which are removed with their bodies.
- **Statuses.** The server derives these: `checking`, `check-failed`, `ready`, `waiting-for-second-person`, `pinned`, `added-as-latest` and `withdrawn`. A pin the gate refused, a second person rejected, or whose approval expired leaves it `ready`, with a `note` that says why.
- **A deploy's suggested changes.** A deploy that registers a new agent version makes one for it in each project that runs a pinned other version of the agent (`madeBy: deploy`). A project on Latest gets none. With environment orders, it's made when the deployment is promoted into the next project, unless the promotion makes the version live there.
  - Its one change is the code: `{ kind: 'code', deploymentId, imageDigest }`.
  - Its version is the deploy's, and it's never rebuilt: once its project moves, pinning it is `409 suggested-change-out-of-date` with `rebuilding: false`.
  - Its check runs its version on the project's test set. `now` is the newest finished run of the version the project runs on the same frozen cases. With none, the check has no `now`, and its `note` is `{ kind: 'not-running', version }`.
  - With no cases in the project's test set yet, it's made unchecked (`check-failed`).
  - A deploy or a promotion never fails because one couldn't be made: it's logged.
- **The answer.** A suggested change carries:
  - `projectId` and `title`;
  - `madeBy`: who or what made it, which is an Improve run, a person, a service account, a deploy or an offer;
  - `builtOn` and `version`;
  - `changes`: the block, with `from` and `to` (`kind: 'block'`). `GET` of one also adds the content `before` and `after`. A deploy's is the code (`kind: 'code'`);
  - `why` and `fixes`;
  - `check`;
  - `status` and `note` (a pin that didn't go through, or a deploy's `not-running`);
  - `pinned`, `approvalId`, `addedAsLatest` and `withdrawn`.

  `fromVersion`, `scope`, `tier`, `change`, `evidence`, `candidate`, `evaluation`, `promotion` and `rolledBack` are gone.
- **Listing.** `GET /v1/suggested-changes` filters by `agentId`, `projectId`, `status` and `madeBy` (one of its kinds). The `tier` and scope filters are gone.
- **Pinning.** `POST /v1/suggested-changes/{suggestedChangeId}/pin` pins its version for its project, through the project's release gate policy, as before. It's refused for a project that runs Latest (`409 suggested-change-project-on-latest`).
- **If the project moves first.** A suggested change built on a version its project no longer runs is rebuilt on the version the project runs now: its block change made again there (a prompt keeps its wording; settings keep the values it changed and take every other value from what runs now), a new version, and a new check. `builtOn.rebuiltAt` says when.
  - Pinning one (not waiting for a second person) or adding one as Latest rebuilds the project's other `ready` and `check-failed` ones for the agent at once.
  - Checking one again rebuilds it first when its project moved.
  - Pinning or adding one whose project moved is refused (`409 suggested-change-out-of-date`), and starts its rebuild (`details.rebuilding`). One the project's version already has, or whose block it no longer uses, isn't rebuilt (`rebuilding: false`).
- **Adding it as Latest.** `POST /v1/suggested-changes/{suggestedChangeId}/add-as-latest` is new. It makes its version its project's Latest, now, for a project on Latest, with no gate. `reason` is kept on its `addedAsLatest`. It's refused for a project that runs a pin (`409 suggested-change-project-pinned`). It needs `promote` on the agent, and it's allowed from `ready`.
- **One made before this change.** One made for a tenant, an org or a segment reads with the project its version was made in, when that's known. It can only be withdrawn: checking or pinning it is `409 suggested-change-not-for-a-project`.
- **Errors.** Six codes are new:
  - `suggested-change-not-for-a-project` (409);
  - `suggested-change-check-unsupported` (501): the runtime freezes no test set;
  - `suggested-change-nothing-to-check` (409): the project's test set has no cases;
  - `suggested-change-project-on-latest` (409);
  - `suggested-change-project-pinned` (409);
  - `suggested-change-out-of-date` (409).
- **Audit events.** Making one, pinning it, adding it as Latest and withdrawing it are recorded, in its project, with the caller as the actor: `suggested-change-created`, `suggested-change-pinned` (with its promotion, and whether it's pinned or waits for a second person), `suggested-change-added-as-latest` and `suggested-change-withdrawn`. Each names the suggested change, its agent, block, versions and who made it, never its content, its `why` or a reason. The same change sent again records nothing. `EVIDENCE_KINDS` lists the four kinds. The `kind` examples in `compliance-evidence.schema.json` list them too, with the block version and provider kinds.
- **An agent's own test set id is reserved.** Ids starting `agent.` are agents' own test sets, and only a check or a test run makes their versions. `POST /v1/test-sets` and `POST /v1/test-sets/{testSetId}/versions/from-corrections` refuse one from any caller (`400 bad-input`), and the TypeScript client refuses it before sending (`invalid-request`), so `kindgi test-sets from-corrections` does too. A test set with such an id published before keeps reading and running, but a new version of it is refused: publish it under another id. `AGENT_TEST_SET_ID_PREFIX` and `isAgentTestSetId` are exported.
- **Binding.** `TestSetFreezeBinding` freezes a project's test set for a check. With it and suggested changes, `createApp` makes a deploy's suggested changes, through the service's new `fromDeploy` (`DeployCardsInput`, `DeployCardsOutcome`). A stored suggested change's `tier` can be `code` (`StoredSuggestedChangeTier`), with a `CodeChange` (`StoredChange`), and a candidate's `blockVersion` is optional, since a deploy's has none. `agentTestSetId(agentId, projectId)` is the id it freezes under: `agent.<agentId>.<projectId>`. A stored suggested change keeps who drafted its content as `drafter` (`SuggestedChangeDrafter`). It gains `madeBy` (`SuggestedChangeMaker`), `builtOnVersion`, `rebuiltAt` and `addedAsLatest`, and a store records the new `rebuilt` and `added-as-latest` steps. A `rebuilt` step moves it onto a new version: it sets `builtOnVersion`, `rebuiltAt` and its block change there, clears its candidate, evaluation and promotion, and keeps its fingerprint.
- **TypeScript client.**
  - `client.suggestedChanges.create` takes the new body.
  - `check` replaces `evaluate` and `rescore`.
  - `addAsLatest` is new.
  - `list` takes `projectId`, `status` and `madeBy`.
  - `SuggestedChange` follows the answer: a change is a block's or a deploy's code, and a `note` can be `not-running`. `SuggestedChangeTier` and `EvaluateSuggestedChangeInput` are removed.
- **CLI.**
  - `kindgi suggested-changes create` replaces `draft`. It needs `--project`, takes `--fixes` (a correction id, more than once) in place of `--correction`, and drops `--from-version`, `--tenant`, `--org` and `--segment`.
  - `check` replaces `evaluate`: it checks it again, and takes only `--wait`.
  - `pin` replaces `request`.
  - `add-as-latest` is new, with `--reason`.
  - `list` takes `--project`, and drops the scope flags and `--tier`.
  - `get` names each correction in `fixes` that its author has replaced since, with the live one and its status, on stderr. `fixes` keeps the ids it names.
  - The table shows each one's check, for example `25/27 (now 23/27)`. Its BLOCK column is CHANGE: a block and its version, or `code (deploy <deployment-id>)`.
