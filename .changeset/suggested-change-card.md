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
- **The answer.** A suggested change carries:
  - `projectId` and `title`;
  - `madeBy`: who or what made it, which is an Improve run, a person, a service account, a deploy or an offer;
  - `builtOn` and `version`;
  - `changes`: the block, with `from` and `to`. `GET` of one also adds the content `before` and `after`;
  - `why` and `fixes`;
  - `check`;
  - `status` and `note`;
  - `pinned`, `approvalId`, `addedAsLatest` and `withdrawn`.

  `fromVersion`, `scope`, `tier`, `change`, `evidence`, `candidate`, `evaluation`, `promotion` and `rolledBack` are gone.
- **Listing.** `GET /v1/suggested-changes` filters by `agentId`, `projectId`, `status` and `madeBy` (one of its kinds). The `tier` and scope filters are gone.
- **Pinning.** `POST /v1/suggested-changes/{suggestedChangeId}/pin` pins its version for its project, through the project's release gate policy, as before. It's refused for a project that runs Latest (`409 suggested-change-project-on-latest`).
- **Adding it as Latest.** `POST /v1/suggested-changes/{suggestedChangeId}/add-as-latest` is new. It makes its version its project's Latest, now, for a project on Latest, with no gate. `reason` is kept on its `addedAsLatest`. It's refused for a project that runs a pin (`409 suggested-change-project-pinned`). It needs `promote` on the agent, and it's allowed from `ready`.
- **One made before this change.** One made for a tenant, an org or a segment reads with the project its version was made in, when that's known. It can only be withdrawn: checking or pinning it is `409 suggested-change-not-for-a-project`.
- **Errors.** Five codes are new:
  - `suggested-change-not-for-a-project` (409);
  - `suggested-change-check-unsupported` (501): the runtime freezes no test set;
  - `suggested-change-nothing-to-check` (409): the project's test set has no cases;
  - `suggested-change-project-on-latest` (409);
  - `suggested-change-project-pinned` (409).
- **Audit events.** Making one, pinning it, adding it as Latest and withdrawing it are recorded, in its project, with the caller as the actor: `suggested-change-created`, `suggested-change-pinned` (with its promotion, and whether it's pinned or waits for a second person), `suggested-change-added-as-latest` and `suggested-change-withdrawn`. Each names the suggested change, its agent, block, versions and who made it, never its content, its `why` or a reason. The same change sent again records nothing. `EVIDENCE_KINDS` lists the four kinds. The `kind` examples in `compliance-evidence.schema.json` list them too, with the block version and provider kinds.
- **Binding.** `TestSetFreezeBinding` freezes a project's test set for a check. A stored suggested change keeps who drafted its content as `drafter` (`SuggestedChangeDrafter`). It gains `madeBy` (`SuggestedChangeMaker`), `builtOnVersion`, `rebuiltAt` and `addedAsLatest`, and a store records the new `added-as-latest` step.
- **TypeScript client.**
  - `client.suggestedChanges.create` takes the new body.
  - `check` replaces `evaluate` and `rescore`.
  - `addAsLatest` is new.
  - `list` takes `projectId`, `status` and `madeBy`.
  - `SuggestedChange` follows the answer. `SuggestedChangeTier` and `EvaluateSuggestedChangeInput` are removed.
- **CLI.**
  - `kindgi suggested-changes draft` needs `--project`, and drops `--from-version`, `--tenant`, `--org` and `--segment`.
  - `evaluate` checks it again, and takes only `--wait`.
  - `list` takes `--project`, and drops the scope flags and `--tier`.
  - The table shows each one's check, for example `25/27 (now 23/27)`.
