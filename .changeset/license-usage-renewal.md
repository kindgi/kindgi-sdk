---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A non-production key's renewal can carry the deployment's use.**
- **`GET /v1/license/usage?since=<time>`** (`@kindgi/api`, additive) answers how much the deployment was used since a time:
  - the runs started (not dry runs, replays, evals or child runs);
  - the distinct people who started runs or decided approvals, counted in each tenant and summed;
  - the projects in production, from a runtime that can put projects in production;
  - the runtime's version.

  Counts only: no content, names or ids. Only the deployment's own token reads it; anyone else gets `403 license-operator-only`, recorded, before `since` is read. A `since` up to five minutes ahead of the runtime's clock is taken as now; one that's missing, not a time with a zone, or further ahead is `400 bad-input`. A runtime whose license binding has no `usage` doesn't serve it (404).
- **`LicenseStatusBinding.usage?({ since, until })`** is the binding a runtime gives it, and `LicenseUsage` is its answer. `client.license.usage({ since })` (`@kindgi/client`) and `client.license.usage(since=…)` (Python) read it.
- **`kindgi license renew --runtime <url> --runtime-token <ref>`** reads the deployment's use since its current key was issued and sends it with the renewal, signed with the rest of the request. It prints `counts: sent (…)`, or `counts: not sent (<why>); this renewal goes without them.` when the runtime couldn't say, and the key still renews then. Only whole counts, two times and a short version are sent; any other answer is sent as no counts and never printed. A production key's renewal carries none, and the runtime isn't asked. The runtime's token is checked before it's sent, and a flag that isn't a reference is refused without repeating it. Without the two flags, a renewal carries no counts, as before.
- **`kindgi license renew` prints access.kindgi.com's `held-for-review` refusal** like any other: this renewal's counts are above what a non-production key covers, so it got no new key. Kindgi can release the deployment after a review.
- **The hints about signing in now say what a sign-in does.** A sign-in leaves a key that a deployment is renewing to that deployment, so:
  - `renew`'s ⚠ line says to stop this deployment's renewer first;
  - `kindgi doctor`'s fix says a sign-in shows the key's latest version, and renews it unless a deployment renewed it this week and it hasn't expired, as the runtime's banner does.
