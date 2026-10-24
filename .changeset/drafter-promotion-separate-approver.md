---
"@kindgi/api": patch
---

**A drafter's promotion now requires a separate approver when the tenant has one.** When a proposal a drafter (not a person) wrote is requested for promotion, the gate it waits for asks whether a reviewer other than the requester could decide it: with a second eligible reviewer the requester can no longer approve their own request (`separate-approver-required`, 403); a lone reviewer may still approve, so a one-reviewer tenant isn't stuck. A scope policy's own approval is the floor — its `separateApprover` default of `true` is unchanged, and only an explicit `false` defers to this rule, re-checked at the policy's role. Non-drafted promotions are unaffected.
