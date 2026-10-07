---
"@kindgi/api": patch
"@kindgi/client": patch
---

A gated scope holds its own live version, and a change above it can't move it without its gate.

- **Publishing or reinstating a gate policy** for a scope with no pin of its own is refused (`409 gate-policy-scope-unpinned`), even when a scope above it is pinned. A promotion there would otherwise change the gated scope without its gate.
- **A promotion, rollback or unpin** that would also move a narrower gated scope with no pin of its own (one gated before this rule) is refused with the new `409 gate-policy-descendant-unpinned`. The message names each such scope and its current version: pin it there first. A gated promotion's approval re-checks this, and is `superseded` if it would.
- **A pin in place skips the gate.** Promoting a scope that has no live version of its own to exactly the version it serves now (the fix the new 409 asks for) changes nothing any run gets. So the gate's checks and approval don't apply: it's `201`, with one passing `pinInPlace` check, the policy recorded, and a reason starting `pin-in-place`; `…/promotions/check` says the same. `PromotionRequestInput.gate.pinInPlace` tells the binding, which re-checks it as it writes (`409 promotion-superseded` if the scope moved).
- **The follower guard only refuses a real change:** a promotion that leaves a gated follower on the version it already serves goes through.
- **Unpinning a gated scope's own pin** is `409 gate-policy-needs-pin`: unregister the gate policy first, or roll back instead.
- **Clients:** `gate-policy-descendant-unpinned` is a conflict in TypeScript and Python, like the other gate codes.
