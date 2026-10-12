---
"@kindgi/cli": patch
---

`kindgi license renew` and `kindgi doctor`'s **License key** check trust Kindgi's production license signing key (`lk-2026-p1`) as well as the self-serve one. Production license keys are signed with a key of their own, so a renewed production key is checked offline and written like any other.
