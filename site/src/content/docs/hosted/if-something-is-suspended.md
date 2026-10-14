---
title: If something is suspended
description: What still works when Kindgi suspends a pack, a project or your Kindgi Cloud workspace, what a call into it answers, and what happens when it's restored.
sidebar:
  order: 25
---

Kindgi can suspend one pack, one project or your whole workspace. A
suspension stops what runs in it, and deletes nothing.

The terms of service say when we suspend, and how we tell you.
<!-- Link the Kindgi Cloud terms' section 12 here once they're published. -->

## Your workspace

While your workspace is suspended:

- **You can still sign in, read your data and export it.** Your API keys
  and console sign-ins keep working. So do deleting, erasing a person's
  data and revoking keys
  ([Export your data](../export-your-data/)).
- **Nothing runs.** Runs that hadn't finished are cancelled, including
  queued runs and runs waiting on an approval. Any other change, such as
  starting a run or a deploy, is refused with `409 tenant-suspended`: "This
  workspace is suspended: it can be read and exported, and nothing in it
  changes until it is restored."
- **Your schedules and webhook triggers stop, and stay as they are.**
  Schedules don't fire. A delivery to a webhook trigger that passes its
  signature check is answered `202` with `skipped: tenant-suspended`, so a
  sender such as WooCommerce doesn't count it as a failure. The delivery's
  event isn't kept.

## One project

While a project is suspended:

- **Nothing new runs or deploys in it.** Runs that were going in it are
  cancelled. Starting one is refused with `409 project-suspended`: "The
  project is suspended, so nothing new runs in it until it's restored; no
  run was started." A deploy into it is refused with the same code, before
  anything is written
  ([Organize by org and project](../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project)).
- **The rest of your workspace runs as before,** and the project can still
  be read.
- **Its schedules and webhook triggers are skipped.** A schedule's fire is
  recorded `skipped`: it doesn't count toward the 5 refused or failed fires
  in a row that pause a schedule, and doesn't break the row either
  ([Run on a schedule](../../guides/runs/run-on-a-schedule/)). A delivery
  to one of its webhook triggers is answered `202` with
  `skipped: project-suspended`, and its event isn't kept.

## One pack

Suspending a pack stops that deployment: a call to one of its tools or
checks fails with `pack-suspended`, and doesn't fall back to an older
deployment. No run is cancelled, and the rest of the project, and other
packs, run as before.

If you deploy the pack again with a changed image, the new deployment
runs. When a pack has to stay stopped, Kindgi suspends its project
instead.

## When it's restored

- **What was on runs again.** Schedules and webhook triggers were never
  turned off, so they take their next fire or delivery as before. Your
  packs' services come back with nothing for you to do, after a short wait;
  until a pack's has, a call to its tools fails with
  `pack-endpoint-cleared`.
- **A fire or delivery the suspension caught is recorded `skipped`.** One
  whose run hadn't started when your workspace was suspended is recorded at
  the restore, with "tenant-suspended: its tenant was suspended before its
  run started, so it never ran", and its event isn't kept.
- **Nothing that came due meanwhile runs late.** A schedule fires next at
  its first time after the restore, whatever its catch-up setting.
- **Cancelled runs stay cancelled.** Start them again if you still need
  them.
- **A delivery that was skipped isn't replayed.** If the sender can resend
  an event by hand, send it again once the restore is done.

To ask about a suspension, write to contact@kindgi.com.

## Next

- [Export your data](../export-your-data/): what your workspace holds, as
  files.
- [Limits](../limits/): what every account can do at once.
