---
"@kindgi/api": patch
---

**A deploy's rollback now warns when it can't undo one of its writes.** When `POST /v1/deployments` fails partway, it undoes what it wrote, last write first. An undo that failed used to be dropped without a word. It's now logged as a warn naming what's left as the deploy wrote it, for example `deploy rollback: couldn't unregister tool "acme.score@1.0.0", so it stays as this deploy left it`, with the fields `primitive`, `id` and `err`. The rest of the rollback still runs.
