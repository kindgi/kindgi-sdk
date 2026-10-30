---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**A correction says whether a run's decisions and answer were right, and it moves until it's fixed.** This is a breaking change to the corrections API, and no old field is kept.

- **One correction per run.** `POST /v1/corrections` takes `decisions` and `answer` (`right` or `wrong`) and `items`, at least one of them.
  - `decisions: "wrong"` needs `shouldCall` (`[{ tool, args? }]`, with `args` only when the inputs matter) or `mustNotCall` (tool ids).
  - `answer: "wrong"` needs `shouldSay` (what it should have said) or `why`.
  - `items` (`[{ key, pointer?, rank?, verdict }]`) is for an answer that is a ranked list. A wrong item needs nothing more.
  - `item`, `verdict`, `reason` and `correction` are gone, and sending one is a 400 that names its new field. A second correction by the same caller on the same run, for the same `participantId`, replaces the first.
- **Sorted when it's saved.**
  - A correction from an app's end user (`participantId`, not under a restricted class) stays `open` and unsorted.
  - Wrong decisions go to the agent's owner (`with-owner`).
  - A wrong answer, or a wrong item of it, goes to Improve (`open`).
  - Nothing wrong is `fixed`, as `recorded-right`.
  - A correction answers `status`, `sortedTo`, `sorted`, `link`, `fixedIn`, `statusNote` and `updatedAt`.
- **Changing one.** `PATCH /v1/corrections/{correctionId}` (`client.corrections.change`) re-sorts it, changes its status, or both. It needs `publish` on the agent. A change its status doesn't allow is `409 correction-status-change-not-allowed`, with `details: { from, to }`.
- **Removing one** makes it `removed`. Its author or an admin of its project may remove it.
- **Listing and counting.**
  - `GET /v1/corrections` filters by `status` (`not-fixed` is short for `open`, `being-fixed` and `with-owner`), `sortedTo` (`none` for unsorted), `from` (`experts`, `end-users` or `all`), `madeBy=me` (only the caller's own), `since` and `until`. `verdict` is gone.
  - `GET /v1/corrections/counts` (`client.corrections.counts`) counts a project's corrections, or one agent's, by status.
- **The CLI keeps its flags.** In `kindgi corrections add`, `--correction` is about the run's decisions, `--item=answer` (or `output` for a flow) is its answer, and any other `--item` is an item of a ranked list. Each call adds to your correction of the run, replacing what you said before about the same piece. `kindgi corrections list` loses `--verdict`.
- **For stores.** `CorrectionRegistryBinding` gains `update` (it applies only from the status and sorting it expects), `counts` and `correctionsByIds`. `unregister` sets the status to `removed`. `sortAtSave` and `planChange` are the rules, exported so every store and surface agrees on them.
