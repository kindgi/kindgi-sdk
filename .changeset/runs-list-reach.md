---
"@kindgi/runtime": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**The runs list of someone who may only run a project comes in full pages.** `GET /v1/runs` lists every run in the projects the caller may `read`, and in the projects where they may only `run` (a `runner`, or everyone when the project has `everyoneCanRun`), the runs that act for them (a run's `actsFor`). It used to read the store's page first and leave out the runs the caller may not see, so such a person's page could come back short, or empty, with more of their runs further on. Now the runtime applies it in its query: a page is full when there are more, and its cursor names one of the caller's runs. Across projects (no scope, the workspace or an org), those projects come from the authorization store's list, which answers at most 1000 by default: a caller who reads or runs more may miss the runs of some. A workspace admin's list doesn't go through it. `@kindgi/runtime`'s `ListRunsInput` gains `reach` (`RunListReach`: `allIn`, `ownIn` and `actsFor`), the projects a run binding's `listRuns` lists in, and `actsFor`.

**`GET /v1/runs?actsFor=me`**: only the runs that act for the caller; none for a caller who acts for no one. Any other value is a `400`. `@kindgi/client`'s `runs.list` takes `actsFor: 'me'`.

**Someone who may only run a project reaches their own files there.** With `run` and no `read` on the project, they may upload a file that names no `ownerRunId` (an input for a run they start) and download it again, download a file a run that acts for them stored (`GET` and `HEAD`), and list a run's files with `?ownerRunId=` of a run of their own. Anyone else's files stay hidden (`404`), and deleting a file still needs `write` (`403`).
