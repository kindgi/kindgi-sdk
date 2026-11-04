---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**A license key can set when it starts warning and what it limits, and a signing key can cap how long its keys run.**

- `@kindgi/cli`:
  - **Warning window.** A key's `warn`, in whole days from 1 to 30, is when it starts warning that it expires. Without it, the window is 30 days, as before. `kindgi doctor` and `kindgi license renew` warn from it.
  - **Limits.** A production key's `lim` is read: `flows` and `agents`, whole numbers from 1 to 100000. A key isn't a key if either is out of range, or if a non-production key has a `lim`.
  - **Cap.** A signing key (`kid`) can cap the days from a key's `iat` to its `exp`. A longer key is refused as `too-long`: `kindgi doctor` fails it, as the runtime won't start with it, and renewal doesn't write it. No signing key has a cap yet.
  - **Older keys.** Renewal now also refuses a key that expires at the same time as the current one but was issued earlier.
- `@kindgi/api`: the license (`GET /v1/license`) gains `limits` in its operator's view. A tenant admin's view doesn't have it. For each count the key limits, it gives:
  - `plan`: the number the key carries;
  - `most`: the most the runtime runs; past it, it refuses new ones;
  - `inUse`: how many it counts now.
