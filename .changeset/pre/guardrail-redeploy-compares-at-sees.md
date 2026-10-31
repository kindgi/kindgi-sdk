---
"@kindgi/api": patch
---

**A redeploy compares a guardrail's `at` and `sees`.** A deploy keeps an already-registered guardrail only when its definition hasn't changed, and that comparison left out `at` and `sees`. So a pack that changed only where a guardrail runs, or what its check sees, deployed, and the guardrail went on running as it was first registered. That's now a definition change, refused as `guardrail-already-registered` like any other: unregister the guardrail (`kindgi guardrails unregister <id>`) and deploy again. A guardrail an earlier deploy kept with its old `at` or `sees` is refused the same way on the pack's next deploy. An absent `at` matches an explicit `'final-answer'`, and an absent `sees` an explicit `'turn'`, so an unchanged pack redeploys as before.
